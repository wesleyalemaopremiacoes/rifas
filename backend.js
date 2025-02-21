"use strict";
const axios = require("axios");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(bodyParser.json());
app.use(cors());

const ACCESS_TOKEN = "APP_USR-7155153166578433-022021-bb77c63cb27d3d05616d5c08e09077cf-502781407";

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

    if (!response.data.point_of_interaction || !response.data.point_of_interaction.transaction_data) {
      throw new Error("Dados do pagamento não retornados corretamente");
    }

    return {
      txid: response.data.id,
      qrcode: response.data.point_of_interaction.transaction_data.qr_code,
      copiaECola: response.data.point_of_interaction.transaction_data.qr_code_base64,
    };
  } catch (error) {
    console.error("Erro ao gerar chave PIX:", error.response?.data || error.message);
    throw new Error(error.response?.data?.message || "Erro ao gerar chave PIX");
  }
}

app.post("/gerar-chave-pix", async (req, res) => {
  try {
    const { valor, payerEmail, payerCpf } = req.body;
    if (!valor || isNaN(valor) || valor <= 0) {
      return res.status(400).json({ error: "Valor inválido" });
    }

    const qrcodeData = await gerarChavePix(parseFloat(valor), payerEmail, payerCpf);
    res.json(qrcodeData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/verificar-status", async (req, res) => {
  try {
    const { txid } = req.body;
    if (!txid) return res.status(400).json({ error: "txid não fornecido" });

    const response = await axios.get(`https://api.mercadopago.com/v1/payments/${txid}`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    res.json({ status: response.data.status });
  } catch (error) {
    res.status(500).json({ error: "Erro ao verificar status do pagamento" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
