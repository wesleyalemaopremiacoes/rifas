"use strict";
const axios = require("axios");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg");
const nodemailer = require("nodemailer");
const mysql = require('mysql2/promise');

const app = express();
app.use(bodyParser.json());
app.use(cors());

// === Logging middleware para debug (method, path, body) ===
app.use((req, res, next) => {
  try {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} body=${JSON.stringify(req.body || {})}`);
  } catch(e) { /* ignore logging errors */ }
  next();
});

/********************
 * CONFIGURAÇÃO PIX *
 ********************/
const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "APP_USR-7155153166578433-022021-bb77c63cb27d3d05616d5c08e09077cf-502781407";
const PAGAMENTOS_FILE = "pagamentos.json";

if (!fs.existsSync(PAGAMENTOS_FILE)) {
  fs.writeFileSync(PAGAMENTOS_FILE, JSON.stringify([]));
}

/********************
 * CONFIGURAÇÃO E-MAIL *
 ********************/
const SMTP_EMAIL = process.env.SMTP_EMAIL || "joreljunior0102@gmail.com";
const SMTP_PASS  = process.env.SMTP_PASS  || "M10019210a";
const NOTIFY_TO   = process.env.NOTIFY_TO  || SMTP_EMAIL;

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: SMTP_EMAIL, pass: SMTP_PASS },
});

async function enviarNotificacaoEmail(pagamento, tipo = "gerado") {
  try {
    const assunto = tipo === "aprovado"
      ? `Pagamento PIX aprovado ✅ - txid: ${pagamento.txid}`
      : `Nova chave PIX gerada (pendente) - txid: ${pagamento.txid}`;

    let html = `
      <h2>${tipo === "aprovado" ? "Pagamento aprovado" : "Chave PIX gerada"}</h2>
      <p><b>TXID:</b> ${pagamento.txid}</p>
      <p><b>Valor:</b> R$ ${Number(pagamento.valor).toFixed(2)}</p>
      <p><b>Email do pagador:</b> ${pagamento.payerEmail || "-"}</p>
      <p><b>CPF:</b> ${pagamento.payerCpf || "-"}</p>
      <p><b>Status:</b> ${pagamento.status || "-"}</p>
      <p><b>Copia e Cola:</b> <code>${pagamento.copiaECola || "-"}</code></p>
    `;

    if (pagamento.qrcodeBase64) {
      html += `<p><img src="data:image/png;base64,${pagamento.qrcodeBase64}" alt="QR Code" style="max-width:300px;"/></p>`;
    }

    await transporter.sendMail({
      from: `"Notificação PIX" <${SMTP_EMAIL}>`,
      to: NOTIFY_TO,
      subject: assunto,
      html,
    });

    console.log(`📧 Notificação enviada (${tipo}) — txid=${pagamento.txid}`);
  } catch (err) {
    console.error("❌ Erro ao enviar e-mail:", err.message || err);
  }
}

/********************
 * FUNÇÃO GERAR PIX *
 ********************/
async function gerarChavePix(valor, payerEmail, payerCpf) {
  try {
    const idempotencyKey = uuidv4();
    const response = await axios.post(
      "https://api.mercadopago.com/v1/payments",
      {
        transaction_amount: valor,
        description: "Pagamento via PIX",
        payment_method_id: "pix",
        payer: { email: payerEmail, identification: { type: "CPF", number: payerCpf } }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
          "X-Idempotency-Key": idempotencyKey,
        },
      }
    );

    const qrcodeData = {
      txid: response.data.id,
      qrcodeBase64: response.data.point_of_interaction.transaction_data.qr_code_base64,
      copiaECola: response.data.point_of_interaction.transaction_data.qr_code,
      valor,
      payerEmail,
      payerCpf,
      status: "pending",
    };

    console.log(`Chave PIX gerada: ${JSON.stringify(qrcodeData)}`);
    return qrcodeData;

  } catch (error) {
    console.error("Erro ao gerar chave PIX:", error.response?.data || error.message);
    throw new Error(error.response?.data?.message || "Erro ao gerar chave PIX");
  }
}

/********************
 * ROTAS PIX
 ********************/
app.post("/gerar-chave-pix", async (req, res) => {
  try {
    const { valor, payerEmail, payerCpf } = req.body;
    if (!valor || isNaN(valor) || valor <= 0) return res.status(400).json({ error: "Valor inválido" });

    const qrcodeData = await gerarChavePix(parseFloat(valor), payerEmail, payerCpf);
    const pagamentos = JSON.parse(fs.readFileSync(PAGAMENTOS_FILE, "utf8"));
    pagamentos.push(qrcodeData);
    fs.writeFileSync(PAGAMENTOS_FILE, JSON.stringify(pagamentos, null, 2));

    enviarNotificacaoEmail(qrcodeData, "gerado").catch(e => console.error(e));
    res.json(qrcodeData);

  } catch (error) {
    console.error("Erro ao gerar chave PIX:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post("/verificar-status", async (req, res) => {
  const { txid } = req.body;
  if (!txid) return res.status(400).json({ error: "txid não fornecido" });

  try {
    const response = await axios.get(`https://api.mercadopago.com/v1/payments/${txid}`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    const status = response.data.status;
    const pagamentos = JSON.parse(fs.readFileSync(PAGAMENTOS_FILE, "utf8"));
    const pagamento = pagamentos.find(p => p.txid === txid);
    if (pagamento) {
      pagamento.status = status;
      fs.writeFileSync(PAGAMENTOS_FILE, JSON.stringify(pagamentos, null, 2));
    }

    res.json({ status });
  } catch (error) {
    console.error("Erro verificar-status:", error?.response?.data || error?.message || error);
    res.status(500).json({ error: "Erro ao verificar status do pagamento" });
  }
});

async function atualizarStatusPagamentos() {
  try {
    const pagamentos = JSON.parse(fs.readFileSync(PAGAMENTOS_FILE, "utf8"));
    for (const pagamento of pagamentos) {
      if (pagamento.status !== "approved") {
        const response = await axios.get(`https://api.mercadopago.com/v1/payments/${pagamento.txid}`, {
          headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
        });
        const novoStatus = response.data.status;
        if (novoStatus === "approved" && pagamento.status !== "approved") {
          pagamento.status = novoStatus;
          enviarNotificacaoEmail(pagamento, "aprovado").catch(e => console.error(e));
          console.log(`Pagamento aprovado: txid=${pagamento.txid}, valor=${pagamento.valor}`);
        } else {
          pagamento.status = novoStatus;
        }
      }
    }
    fs.writeFileSync(PAGAMENTOS_FILE, JSON.stringify(pagamentos, null, 2));
    console.log("Status dos pagamentos atualizado com sucesso.");
  } catch (error) {
    console.error("Erro ao atualizar status dos pagamentos:", error.message);
  }
}
setInterval(atualizarStatusPagamentos, 60000);

/********************
 * POSTGRES POOL RIFA
 ********************/
const DEFAULT_RIFA_DB_URL = "postgresql://rifa_user:KPZADel5FKz3FcLOPDcx5pYoRD9lA9UV@dpg-d3ong26uk2gs73dpqtjg-a.oregon-postgres.render.com/rifas_db_lw07";
const RIFA_DB_URL = process.env.RIFA_DB_URL || DEFAULT_RIFA_DB_URL;

const poolRifa = new Pool({
  connectionString: RIFA_DB_URL,
  ssl: { rejectUnauthorized: false }
});

const MAX_NUMBERS = process.env.RIFA_MAX_NUMBERS ? parseInt(process.env.RIFA_MAX_NUMBERS, 10) : 300;

async function ensureRifaTable() {
  const sql = `
    CREATE TABLE IF NOT EXISTS rifa_numeros (
      numero INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      buyer_name VARCHAR(150) NOT NULL,
      phone_last4 VARCHAR(4),
      txid VARCHAR(128) NOT NULL,
      comprado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `;
  try {
    await poolRifa.query(sql);
    console.log("✅ Tabela rifa_numeros garantida no Postgres (Render).");
  } catch (err) {
    console.error("❌ Erro ao garantir tabela rifa_numeros:", err);
    process.exit(1);
  }
}

/********************
 * MySQL pool (usuarios)
 ********************/
const MYSQL_CONFIG = {
  host: process.env.MYSQL_HOST || "sql111.infinityfree.com",
  user: process.env.MYSQL_USER || "if0_40091435",
  password: process.env.MYSQL_PASS || "m10019210A",
  database: process.env.MYSQL_DB   || "if0_40091435_Fumacatech",
  waitForConnections: true,
  connectionLimit: 5,
  decimalNumbers: true
};
const mysqlPool = mysql.createPool(MYSQL_CONFIG);

/********************
 * ENDPOINTS RIFA
 ********************/
app.get("/rifa/numeros", async (req, res) => {
  try {
    const { rows } = await poolRifa.query("SELECT numero, buyer_name, phone_last4, txid, comprado_em FROM rifa_numeros ORDER BY numero ASC");
    return res.json(rows);
  } catch (err) {
    console.error("Erro /rifa/numeros:", err);
    return res.status(500).json({ error: "Erro ao buscar números da rifa", details: String(err) });
  }
});

app.get("/rifa/numero/:numero", async (req, res) => {
  try {
    const numero = parseInt(req.params.numero, 10);
    if (!numero || numero < 1 || numero > MAX_NUMBERS) return res.status(400).json({ error: "Número inválido" });

    const { rows } = await poolRifa.query(
      "SELECT numero, buyer_name, phone_last4, txid, comprado_em FROM rifa_numeros WHERE numero = $1",
      [numero]
    );

    if (rows.length === 0) return res.status(404).json({ error: "Disponível" });
    return res.json(rows[0]);
  } catch (err) {
    console.error("Erro /rifa/numero/:numero", err);
    return res.status(500).json({ error: "Erro ao buscar dados do número.", details: String(err) });
  }
});

app.post("/rifa/reservar", async (req, res) => {
  const { quantidade, userId, txid, buyer_name, phone_last4, maxNumber } = req.body;
  const maxNum = Number.isInteger(maxNumber) && maxNumber > 0 ? maxNumber : MAX_NUMBERS;

  if (!quantidade || !Number.isInteger(quantidade) || quantidade <= 0) return res.status(400).json({ error: "quantidade inválida" });
  if (!txid) return res.status(400).json({ error: "txid é obrigatório" });
  if (!userId) return res.status(400).json({ error: "userId é obrigatório" });
  if (quantidade > maxNum) return res.status(400).json({ error: "quantidade maior que total de números da rifa" });

  const client = await poolRifa.connect();
  try {
    await client.query("BEGIN");

    let buyerName = buyer_name || null;
    let phoneLast4 = phone_last4 || null;

    if (!buyerName || !phoneLast4) {
      try {
        const [userRows] = await mysqlPool.query("SELECT id, nome, telefone FROM usuarios WHERE id = ? LIMIT 1", [userId]);
        if (!userRows || userRows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Usuário não encontrado" });
        }
        const u = userRows[0];
        if (!buyerName) buyerName = String(u.nome || "Comprador");
        if (!phoneLast4 && u.telefone) {
          const t = String(u.telefone || "");
          phoneLast4 = t.length >= 4 ? t.slice(-4) : t;
        }
      } catch (mysqlErr) {
        await client.query("ROLLBACK");
        console.error("Erro lendo usuario no MySQL:", mysqlErr);
        return res.status(500).json({ error: "Erro ao ler usuário", details: String(mysqlErr) });
      }
    }

    const selectTakenSql = "SELECT numero FROM rifa_numeros FOR UPDATE";
    const takenRes = await client.query(selectTakenSql);
    const takenSet = new Set(takenRes.rows.map(r => r.numero));

    const available = [];
    for (let i = 1; i <= maxNum; i++) if (!takenSet.has(i)) available.push(i);

    if (available.length < quantidade) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Números insuficientes disponíveis", available: available.length });
    }

    const chosen = [];
    while (chosen.length < quantidade) {
      const idx = Math.floor(Math.random() * available.length);
      chosen.push(available.splice(idx, 1)[0]);
    }

    const insertSql = "INSERT INTO rifa_numeros (numero, user_id, buyer_name, phone_last4, txid) VALUES ($1,$2,$3,$4,$5)";
    for (const numero of chosen) await client.query(insertSql, [numero, userId, buyerName, phoneLast4, txid]);

    await client.query("COMMIT");
    console.log(`Reserva OK userId=${userId} txid=${txid} números=${JSON.stringify(chosen)}`);
    return res.json({ reserved: chosen });

  } catch (err) {
    try { await client.query("ROLLBACK"); } catch(e){ /* ignore */ }
    console.error("Erro /rifa/reservar:", err && err.stack ? err.stack : err);
    if (err && err.code === '23505') return res.status(409).json({ error: "Conflito ao reservar (repetição de número). Tente novamente." });
    return res.status(500).json({ error: "Erro interno ao reservar números", details: String(err).slice(0,2000) });
  } finally {
    client.release();
  }
});

// aliases
app.post("/reservar", async (req, res) => { return app._router.handle(req, res, () => {}, "/rifa/reservar"); });
app.post("/rifas/reservar", async (req, res) => { return app._router.handle(req, res, () => {}, "/rifa/reservar"); });

/********************
 * DELETE /rifa/numero/:numero
 ********************/
app.delete("/rifa/numero/:numero", async (req, res) => {
  const numero = parseInt(req.params.numero, 10);
  if (!numero || numero < 1 || numero > MAX_NUMBERS) return res.status(400).json({ error: "Número inválido" });

  const client = await poolRifa.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT numero FROM rifa_numeros WHERE numero = $1", [numero]);
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Número não encontrado" });
    }
    await client.query("DELETE FROM rifa_numeros WHERE numero = $1", [numero]);
    await client.query("COMMIT");
    console.log(`Número ${numero} excluído da rifa`);
    return res.json({ success: true, numero });
  } catch (err) {
    await client.query("ROLLBACK").catch(()=>{});
    console.error("Erro ao excluir número:", err);
    return res.status(500).json({ error: "Erro ao excluir número", details: String(err) });
  } finally {
    client.release();
  }
});

/********************
 * POST /rifa/delete (excluir múltiplos números)
 ********************/
app.post("/rifa/delete", async (req, res) => {
  const { numeros } = req.body;
  if (!Array.isArray(numeros) || numeros.length === 0) return res.status(400).json({ error: "Nenhum número fornecido" });

  const client = await poolRifa.connect();
  try {
    await client.query("BEGIN");
    const deleted = [];

    for (const num of numeros) {
      const numero = parseInt(num, 10);
      if (!numero || numero < 1 || numero > MAX_NUMBERS) continue;

      const { rowCount } = await client.query(
        "DELETE FROM rifa_numeros WHERE numero = $1",
        [numero]
      );
      if (rowCount > 0) deleted.push(numero);
    }

    await client.query("COMMIT");
    return res.json({ success: true, deleted });

  } catch (err) {
    await client.query("ROLLBACK").catch(()=>{});
    console.error("Erro ao apagar números:", err);
    return res.status(500).json({ error: "Erro ao apagar números", details: String(err) });
  } finally {
    client.release();
  }
});

/********************
 * Inicialização
 ********************/
(async function start() {
  try {
    await ensureRifaTable();

    try {
      await mysqlPool.getConnection().then(conn=>conn.release());
      console.log("Conectado ao MySQL (InfinityFree) para usuários.");
    } catch (mysqlErr) {
      console.warn("Não foi possível conectar ao MySQL (usuarios). Erro:", mysqlErr.message || mysqlErr);
    }

    await poolRifa.query("SELECT 1");
    console.log("Conectado ao Postgres (Render) para rifa.");

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
  } catch (err) {
    console.error("Erro na inicialização do backend:", err);
    process.exit(1);
  }
})();