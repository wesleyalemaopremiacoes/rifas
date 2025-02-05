"use strict";
const https = require("https");
const axios = require("axios");
const fs = require("fs");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");

// Configurações do servidor
const app = express();
app.use(bodyParser.json());
app.use(cors());

// Caminho do certificado .p12
const certificado = fs.readFileSync("./producao-680610-premio.p12");

// Credenciais do PIX
const credenciais = {
  client_id: "Client_Id_5292a7850c8ba56c5d8d28c4d882bcd226203df5",
  client_secret: "Client_Secret_1827eaffaf296a8115b7995eca0a44ae34740d8a",
};

// Codificando as credenciais em base64
const data_credentials = `${credenciais.client_id}:${credenciais.client_secret}`;
const auth = Buffer.from(data_credentials).toString("base64");

// Função para gerar chave Pix e QR Code
async function gerarChavePix(valor) {
  try {
    console.log("Iniciando a geração da chave Pix...");
    const agent = new https.Agent({
      pfx: certificado,
      passphrase: "", // Se houver senha, insira aqui
    });

    // Configuração do token
    const configToken = {
      method: "POST",
      url: "https://pix.api.efipay.com.br/oauth/token",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      httpsAgent: agent,
      data: JSON.stringify({ grant_type: "client_credentials" }),
    };

    const tokenResponse = await axios(configToken);
    const token = tokenResponse.data.access_token;

    console.log("Token de acesso recebido:", token);

    // Configurando a cobrança
    const configCob = {
      method: "POST",
      url: "https://pix.api.efipay.com.br/v2/cob",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      httpsAgent: agent,
      data: JSON.stringify({
        calendario: { expiracao: 3600 },
        valor: { original: valor.toFixed(2) },
        chave: "aea61daf-326c-4121-89a6-17f7544dedcf", // Substitua pela sua chave Pix
        solicitacaoPagador: "Pagamento de títulos",
      }),
    };

    console.log("Enviando solicitação de cobrança...");
    const cobResponse = await axios(configCob);
    const { txid, loc } = cobResponse.data;

    console.log("Cobrança criada com sucesso:", cobResponse.data);

    // Validar a location e o QR Code
    const qrCodeResponse = await axios.get(`https://pix.api.efipay.com.br/v2/loc/${loc.id}/qrcode`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      httpsAgent: agent,
    });

    const { imagemQrcode, qrcode } = qrCodeResponse.data;

    return {
      txid,
      qrcode,
      imagemQrcode,
    };
  } catch (error) {
    console.error("Erro ao gerar chave Pix:", error);
    if (error.response) {
      console.error("Resposta de erro da API:", error.response.data);
    }
    throw error;
  }
}

// Rota para gerar a chave Pix
app.post("/gerar-chave-pix", async (req, res) => {
  try {
    const { valor } = req.body;

    if (!valor || isNaN(valor)) {
      return res.status(400).json({ error: "Valor inválido" });
    }

    const qrcodeData = await gerarChavePix(parseFloat(valor));

    res.json({
      txid: qrcodeData.txid,
      qrcode: qrcodeData.qrcode,
      imagemQrcode: qrcodeData.imagemQrcode,
    });
  } catch (error) {
    console.error("Erro ao gerar chave Pix:", error);
    res.status(500).json({ error: "Erro ao gerar chave Pix" });
  }
});

// Rota para verificar o pagamento
app.post("/verificar-pagamento", async (req, res) => {
  try {
    const { txid } = req.body;

    if (!txid) {
      return res.status(400).json({ error: "TXID é obrigatório" });
    }

    const agent = new https.Agent({
      pfx: certificado,
      passphrase: "",
    });

    // Configuração para consultar status do pagamento
    const configConsulta = {
      method: "GET",
      url: `https://pix.api.efipay.com.br/v2/cob/${txid}`,
      headers: {
        Authorization: `Bearer ${auth}`,
        "Content-Type": "application/json",
      },
      httpsAgent: agent,
    };

    const consultaResponse = await axios(configConsulta);
    res.json(consultaResponse.data);
  } catch (error) {
    console.error("Erro ao verificar pagamento:", error);
    if (error.response) {
      console.error("Resposta de erro da API:", error.response.data);
    }
    res.status(500).json({ error: "Erro ao verificar pagamento" });
  }
});

// Iniciando o servidor
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
