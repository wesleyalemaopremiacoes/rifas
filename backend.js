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

    // Adicionando log
    console.log(`Chave PIX gerada: ${JSON.stringify(qrcodeData)}`);

    return qrcodeData;
  } catch (error) {
    console.error("Erro ao gerar chave PIX:", error.response?.data || error.message);
    throw new Error(error.response?.data?.message || "Erro ao gerar chave PIX");
  }
}

// Rota para gerar a chave PIX e salvar o pagamento no arquivo
app.post("/gerar-chave-pix", async (req, res) => {
  try {
    const { valor, payerEmail, payerCpf } = req.body;
    if (!valor || isNaN(valor) || valor <= 0) {
      return res.status(400).json({ error: "Valor inválido" });
    }

    const qrcodeData = await gerarChavePix(parseFloat(valor), payerEmail, payerCpf);

    // Salvar pagamento no arquivo
    const pagamentos = JSON.parse(fs.readFileSync(PAGAMENTOS_FILE, "utf8"));
    pagamentos.push(qrcodeData);
    fs.writeFileSync(PAGAMENTOS_FILE, JSON.stringify(pagamentos, null, 2));

    // Adicionando log
    console.log(`Chave PIX gerada com sucesso: txid=${qrcodeData.txid}, valor=${qrcodeData.valor}, email=${qrcodeData.payerEmail}`);

    res.json(qrcodeData);
  } catch (error) {
    console.error("Erro ao gerar chave PIX:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Função para enviar o e-mail
async function enviarEmail(destinatario, assunto, conteudo) {
  try {
    const response = await axios.post(
      "https://wesleyalemaopremios-com-br.onrender.com/enviar-email",
      {
        to: destinatario,
        subject: assunto,
        text: conteudo,
      }
    );
    console.log(`E-mail enviado para ${destinatario}: ${assunto}`);
    return response.data;
  } catch (error) {
    console.error("Erro ao enviar e-mail:", error.response?.data || error.message);
    throw new Error(error.response?.data?.message || "Erro ao enviar e-mail");
  }
}

// Função para atualizar o status dos pagamentos e verificar se deve enviar e-mail
async function atualizarStatusPagamento(txid) {
  try {
    const pagamentos = JSON.parse(fs.readFileSync(PAGAMENTOS_FILE, "utf8"));
    const pagamento = pagamentos.find(p => p.txid === txid);

    if (!pagamento || pagamento.status === "approved") {
      return; // Se o pagamento não for encontrado ou já estiver aprovado, não faz nada
    }

    console.log(`Verificando pagamento com txid ${pagamento.txid}...`);
    const response = await axios.get(`https://api.mercadopago.com/v1/payments/${pagamento.txid}`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    const novoStatus = response.data.status;
    if (novoStatus !== pagamento.status) {
      pagamento.status = novoStatus; // Atualiza o status

      // Se o status mudar para "approved", envia o e-mail
      if (novoStatus === "approved") {
        console.log(`Pagamento aprovado com txid ${pagamento.txid}. Enviando e-mail...`);
        await enviarEmail(pagamento.payerEmail, "Pagamento Aprovado", `Seu pagamento de R$ ${pagamento.valor} foi aprovado com sucesso.`);
      }

      // Salvar o status atualizado
      fs.writeFileSync(PAGAMENTOS_FILE, JSON.stringify(pagamentos, null, 2));
    }
  } catch (error) {
    console.error("Erro ao atualizar status do pagamento:", error.message);
  }
}

// Rota para listar apenas os pagamentos aprovados
app.get("/pagamentos", (req, res) => {
  try {
    const pagamentos = JSON.parse(fs.readFileSync(PAGAMENTOS_FILE, "utf8"));
    const pagamentosAprovados = pagamentos.filter((p) => p.status === "approved");
    res.json(pagamentosAprovados);
  } catch (error) {
    res.status(500).json({ error: "Erro ao carregar pagamentos" });
  }
});

// Rota para verificar o status de um pagamento manualmente
app.post("/verificar-status", async (req, res) => {
  const { txid } = req.body;
  if (!txid) {
    return res.status(400).json({ error: "txid não fornecido" });
  }

  try {
    const response = await axios.get(`https://api.mercadopago.com/v1/payments/${txid}`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    const status = response.data.status;

    // Atualizar o status no arquivo
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

// Rota para enviar o e-mail
app.post("/enviar-email", async (req, res) => {
  const { to, subject, text } = req.body;
  if (!to || !subject || !text) {
    return res.status(400).json({ error: "Informações de e-mail incompletas" });
  }

  try {
    // Lógica para enviar o e-mail via API de e-mail
    console.log(`Enviando e-mail para ${to} com o assunto: ${subject}`);
    res.status(200).json({ message: "E-mail enviado com sucesso" });
  } catch (error) {
    res.status(500).json({ error: "Erro ao enviar e-mail" });
  }
});

// Função para atualizar automaticamente os pagamentos a cada 5 segundos
setInterval(() => {
  const pagamentos = JSON.parse(fs.readFileSync(PAGAMENTOS_FILE, "utf8"));
  pagamentos.forEach(pagamento => {
    if (pagamento.status !== "approved") {
      atualizarStatusPagamento(pagamento.txid);
    }
  });
}, 5000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
