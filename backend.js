"use strict";
const axios = require("axios");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(bodyParser.json());
app.use(cors());

const ACCESS_TOKEN = "APP_USR-7155153166578433-022021-bb77c63cb27d3d05616d5c08e09077cf-502781407";
const PAGAMENTOS_FILE = "pagamentos.json";

// Inicializar arquivo se não existir
if (!fs.existsSync(PAGAMENTOS_FILE)) {
  fs.writeFileSync(PAGAMENTOS_FILE, JSON.stringify([]));
}

// Função para gerar Pix
async function gerarPix(valor, payerEmail, payerCpf) {
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
            number: payerCpf
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
          "X-Idempotency-Key": idempotencyKey
        }
      }
    );

    const data = response.data.point_of_interaction.transaction_data;

    // Retornando TXID, QRCode (imagem base64) e chave para copiar
    return {
      txid: response.data.id,
      qrcode: data.qr_code_base64,    // imagem para exibir
      copiaECola: data.qr_code,       // string para copiar
      valor,
      payerEmail,
      payerCpf,
      status: "pending"
    };
  } catch (err) {
    console.error("Erro ao gerar Pix:", err.response?.data || err.message);
    throw new Error("Erro ao gerar Pix");
  }
}

// Endpoint usado pelo front-end
app.post("/gerar-chave-pix", async (req, res) => {
  try {
    const { valor, payerEmail, payerCpf } = req.body;
    if (!valor || isNaN(valor) || valor <= 0) {
      return res.status(400).json({ error: "Valor inválido" });
    }
    if (!payerEmail || !payerCpf) {
      return res.status(400).json({ error: "Email ou CPF não fornecido" });
    }

    const pixData = await gerarPix(parseFloat(valor), payerEmail, payerCpf);

    const pagamentos = JSON.parse(fs.readFileSync(PAGAMENTOS_FILE, "utf8"));
    pagamentos.push(pixData);
    fs.writeFileSync(PAGAMENTOS_FILE, JSON.stringify(pagamentos, null, 2));

    res.json(pixData);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// Atualizar status dos pagamentos
async function atualizarStatusPagamentos() {
  try {
    const pagamentos = JSON.parse(fs.readFileSync(PAGAMENTOS_FILE, "utf8"));
    for (const p of pagamentos) {
      if (p.status !== "approved") {
        const response = await axios.get(`https://api.mercadopago.com/v1/payments/${p.txid}`, {
          headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
        });
        p.status = response.data.status;
      }
    }
    fs.writeFileSync(PAGAMENTOS_FILE, JSON.stringify(pagamentos, null, 2));
  } catch (err) {
    console.error("Erro ao atualizar status:", err.message);
  }
}

// Rota para listar pagamentos aprovados
app.get("/pagamentos", (req, res) => {
  try {
    const pagamentos = JSON.parse(fs.readFileSync(PAGAMENTOS_FILE, "utf8"));
    res.json(pagamentos.filter(p => p.status === "approved"));
  } catch (err) {
    res.status(500).json({ error: "Erro ao carregar pagamentos" });
  }
});

// Verificar status de um pagamento específico
app.post("/verificar-status", async (req, res) => {
  const { txid } = req.body;
  if (!txid) return res.status(400).json({ error: "txid não fornecido" });

  try {
    const response = await axios.get(`https://api.mercadopago.com/v1/payments/${txid}`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
    });

    const status = response.data.status;
    const pagamentos = JSON.parse(fs.readFileSync(PAGAMENTOS_FILE, "utf8"));
    const pagamento = pagamentos.find(p => p.txid === txid);
    if (pagamento) {
      pagamento.status = status;
      fs.writeFileSync(PAGAMENTOS_FILE, JSON.stringify(pagamentos, null, 2));
    }

    res.json({ status });
  } catch (err) {
    res.status(500).json({ error: "Erro ao verificar status" });
  }
}

// Atualização automática
setInterval(atualizarStatusPagamentos, 60000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));