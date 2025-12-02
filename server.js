// server.js
const express = require("express");
const path = require("path");
const axios = require("axios");
const { prodPool, uatPool } = require("./db");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ===================== CONFIGURACIÓN API 1 (MERCADO PAGO) =====================

const API1_BASE_URL = "https://api.mercadopago.com/v1/payments/search";

const API1_DEFAULT_HEADERS = {
  // Este token debe moverse a process.env.MP_ACCESS_TOKEN antes de subir a repos/AWS.
  "Authorization":
    "Bearer APP_USR-4048311431295047-110800-544ad44d3cb4a0e8e8880223481937b1-669403414",
};

// Tabla de PROD y UAT (ajustar si el esquema o nombre cambia)
const PROD_TABLE = "diriprod.diri_webhook_mercadopago";
const UAT_TABLE = "diriuat.diri_webhook_mercadopago"; // ajustar si en UAT se llama distinto

// ======================= ENDPOINT PRINCIPAL /run-flow =========================

app.post("/run-flow", async (req, res) => {
  const { folioCompra, brandNumber, gateway, tipoOperacion } = req.body;
  const log = [];

  try {
    // ===================== VALIDACIONES BÁSICAS =====================

    if (!folioCompra || typeof folioCompra !== "string" || folioCompra.length > 100) {
      return res.status(400).json({
        status: "VALIDACION_ERROR",
        mensaje: "folioCompra no es válido",
      });
    }

    if (brandNumber && !/^[0-9]{1,6}$/.test(brandNumber)) {
      return res.status(400).json({
        status: "VALIDACION_ERROR",
        mensaje: "brandNumber debe ser numérico y de longitud razonable",
      });
    }

    const gw = (gateway || "mercadopago").toLowerCase();
    const gatewaysPermitidos = ["mercadopago", "paypal", "openpay", "stripe"];
    if (!gatewaysPermitidos.includes(gw)) {
      return res.status(400).json({
        status: "VALIDACION_ERROR",
        mensaje: "Pasarela de pago no permitida",
      });
    }

    const tipo = (tipoOperacion || "recarga").toLowerCase();
    const tiposPermitidos = ["recarga", "compra"];
    if (!tiposPermitidos.includes(tipo)) {
      return res.status(400).json({
        status: "VALIDACION_ERROR",
        mensaje: "Tipo de operación no permitido",
      });
    }

    // ===================== LOG DE CONTEXTO =====================

    log.push(`Recibí folioCompra = ${folioCompra}`);
    log.push(`Marca / brandNumber = ${brandNumber || "no especificado"}`);
    log.push(`Pasarela seleccionada = ${gw}`);
    log.push(`Tipo de operación = ${tipo}`);

    // ===================== SELECCIÓN DE PASARELA =====================

    if (gw !== "mercadopago") {
      log.push(`Pasarela ${gw} aún no implementada en el flujo`);
      return res.status(400).json({
        status: "GATEWAY_NO_IMPLEMENTADO",
        mensaje:
          "Por ahora solo está implementado el flujo para MercadoPago. El resto de pasarelas se agregará en fases posteriores.",
        folioCompra,
        brandNumber,
        gateway: gw,
        tipoOperacion: tipo,
        log,
      });
    }

    // ================== PASO 1: GET A LA API 1 REAL (MERCADO PAGO) ==================

    log.push("Llamando API 1 (GET) a Mercado Pago...");

    const api1Response = await axios.get(API1_BASE_URL, {
      headers: API1_DEFAULT_HEADERS,
      params: {
        external_reference: folioCompra,
      },
    });

    log.push("API 1 respondió correctamente");

    const data = api1Response.data || {};
    const results = data.results || [];

    if (results.length === 0) {
      log.push("La búsqueda no devolvió pagos para esa external_reference");
      return res.status(404).json({
        status: "SIN_RESULTADOS",
        mensaje: "No se encontraron pagos para esa referencia en MercadoPago",
        folioCompra,
        brandNumber,
        gateway: gw,
        tipoOperacion: tipo,
        api1Response: data,
        log,
      });
    }

    const primerPago = results[0];

    // ID de pago de Mercado Pago como folioMercado
    const folioMercado = primerPago.id;
    log.push(`Folio de MercadoPago obtenido del primer pago = ${folioMercado}`);

    // ================== PASO 2: SELECT EN PROD USANDO folioMercado ==================

    log.push("Consultando BD PROD con folioMercado...");

    const [rowsProd] = await prodPool.query(
      `SELECT * FROM ${PROD_TABLE} WHERE folio_mercadopago = ?`,
      [folioMercado]
    );

    if (rowsProd.length === 0) {
      log.push("No se encontró ningún registro en PROD para ese folioMercado");
      return res.status(404).json({
        status: "SIN_REGISTRO_PROD",
        mensaje:
          "No hay registro en PROD para ese pago en la tabla diri_webhook_mercadopago",
        folioCompra,
        brandNumber,
        gateway: gw,
        tipoOperacion: tipo,
        folioMercado,
        rowsProd: [],
        api1Response: data,
        log,
      });
    }

    const registroProd = rowsProd[0];
    log.push("Registro encontrado en PROD");

    // ================== PASO 3: VERIFICAR SI YA EXISTE EN UAT ==================

    log.push("Verificando si ya existe registro en UAT para ese folioMercado...");

    const [rowsUatExistentes] = await uatPool.query(
      `SELECT * FROM ${UAT_TABLE} WHERE folio_mercadopago = ?`,
      [folioMercado]
    );

    if (rowsUatExistentes.length > 0) {
      log.push("Registro ya existe en UAT para ese folioMercado; se detiene el flujo.");
      return res.status(409).json({
        status: "EXISTE_EN_UAT",
        mensaje: "El registro ya existe en UAT. Favor de verificar e intentar de nuevo.",
        folioCompra,
        brandNumber,
        gateway: gw,
        tipoOperacion: tipo,
        folioMercado,
        registroProd,
        registroUatExistente: rowsUatExistentes[0],
        api1Response: data,
        log,
      });
    }

    // ================== PASO 4: INSERT EN UAT ==================

    log.push("No existía registro en UAT; insertando registro en UAT...");

    const [insertResult] = await uatPool.query(
      `INSERT INTO ${UAT_TABLE} SET ?`,
      registroProd
    );

    log.push(
      `Registro insertado en UAT con id = ${insertResult.insertId || "sin autoincremento"}`
    );

    // ================== PASO 5: VERIFICACIÓN EN UAT ==================

    log.push("Verificando registro en UAT después del INSERT...");

    const [rowsUatVerificacion] = await uatPool.query(
      `SELECT * FROM ${UAT_TABLE} WHERE folio_mercadopago = ?`,
      [folioMercado]
    );

    if (rowsUatVerificacion.length === 0) {
      log.push("No se encontró el registro recién insertado en UAT");
      return res.status(500).json({
        status: "ERROR_UAT_VERIFICACION",
        mensaje:
          "El INSERT en UAT parece haber fallado; no se encontró el registro al verificar.",
        folioCompra,
        brandNumber,
        gateway: gw,
        tipoOperacion: tipo,
        folioMercado,
        registroProd,
        registroUat: null,
        api1Response: data,
        log,
      });
    }

    const registroUat = rowsUatVerificacion[0];
    log.push("Registro verificado en UAT");

    // ================== RESPUESTA ACTUAL ==================
    // Más adelante se añadirá:
    // - Uso de tipoOperacion y brandNumber para la tabla final de verificación.
    // - POST a API 2 según el tipo de flujo.

    res.json({
      status: "OK",
      mensaje:
        "Flujo de MercadoPago ejecutado: folioMercado obtenido, registro encontrado en PROD e insertado y verificado en UAT (aún sin API 2).",
      folioCompra,
      brandNumber,
      gateway: gw,
      tipoOperacion: tipo,
      folioMercado,
      registroProd,
      registroUat,
      api1Response: data,
      log,
    });
  } catch (error) {
    console.error("Error en /run-flow:", error.message);
    log.push("ERROR en /run-flow: " + error.message);

    if (error.response) {
      return res.status(error.response.status || 500).json({
        status: "ERROR",
        mensaje: "Error al llamar API 1 o procesar su respuesta",
        httpStatus: error.response.status,
        apiErrorBody: error.response.data,
        log,
      });
    }

    res.status(500).json({
      status: "ERROR",
      mensaje: "Error de red o interno al ejecutar el flujo",
      detalle: error.message,
      log,
    });
  }
});

// =========================== LEVANTAR SERVIDOR ================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});