/**
 * SERVIDOR DE SIMULADOR DE PAGOS - QA DIRI
 * ==========================================
 * 
 * Este servidor proporciona un endpoint principal (/run-flow) que simula
 * el reproceso de notificaciones de pagos desde múltiples pasarelas
 * (MercadoPago, PayPal, OpenPay) en un ambiente de pruebas (UAT).
 * 
 * Flujo típico:
 * 1. Buscar el pago en PROD usando criterios específicos por pasarela
 * 2. Insertar el registro en UAT
 * 3. Procesar la notificación a través de la API correspondiente
 * 4. Validar en tablas de negocio y MongoDB
 * 5. Reportar cambios en consumo antes/después
 */

const express = require("express");
const path = require("path");
const axios = require("axios");
const { prodPool, uatPool } = require("./db");  // Conexiones a BD PROD y UAT
const { MongoClient } = require("mongodb");    // Cliente MongoDB para validación

const app = express();

app.use(express.json());                            // Parsea bodies JSON
app.use(express.static(path.join(__dirname, "public"))); // Sirve archivos estáticos

/**
 * ===================== CONFIGURACIÓN API 1 (MERCADO PAGO) =====================
 * 
 * API externa para consultar pagos realizados en MercadoPago.
 * Se utiliza para buscar un pago por external_reference (folioCompra).
 */

// Endpoint de búsqueda de pagos de MercadoPago
const API1_BASE_URL = "https://api.mercadopago.com/v1/payments/search";

// Token de autorización para MercadoPago
// IMPORTANTE: En producción, mover a variable de entorno (.env)
const API1_DEFAULT_HEADERS = {
  Authorization:
    "Bearer APP_USR-4048311431295047-110800-544ad44d3cb4a0e8e8880223481937b1-669403414",
};

/**
 * ===================== CONFIGURACIÓN API 2 (NOTIFICACIÓN MP) =====================
 * 
 * API interna de DIRI que procesa notificaciones de pagos MercadoPago.
 * El endpoint recibe un número de marca como parámetro dinámico.
 */

// Base URL - el brandNumber se concatena al final: /{brandNumber}
const API2_BASE_URL =
  "https://uatserviciosweb.diri.mx/webresources/procesanotificacionmercadopago";

// Headers para autenticación en API 2
const API2_DEFAULT_HEADERS = {
  Authorization: "Bearer 2aRiOCGL9jnmibtVKTWN54zSsjJq",
};

/**
 * ===================== CONFIGURACIÓN API PAYPAL WEBHOOK =====================
 * 
 * API interna de DIRI que procesa webhooks/notificaciones de PayPal.
 * Se utiliza para reprocesar eventos de pago capturado.
 */

// Endpoint para reprocesar el webhook de PayPal
const API_PAYPAL_WEBHOOK_URL =
  "https://uatserviciosweb.diri.mx/webresources/paypalwebhook";

// Headers para autenticación en API PayPal webhook
const API_PAYPAL_WEBHOOK_HEADERS = {
  Authorization: "Bearer 123dagrtetad34gGDs!",
};

/**
 * ===================== CONFIGURACIÓN API OPENPAY WEBHOOK =====================
 * 
 * API interna de DIRI que procesa webhooks/notificaciones de OpenPay.
 * Se utiliza para reprocesar eventos de pago completado (charge.succeeded).
 */

// Endpoint para reprocesar el webhook de OpenPay
const API_OPENPAY_WEBHOOK_URL =
  "https://uatserviciosweb.diri.mx/webresources/webhookopenpay";

// Headers para la API de OpenPay
const API_OPENPAY_WEBHOOK_HEADERS = {};

/**
 * ===================== CONFIGURACIÓN API DETALLE CONSUMO DN =====================
 * 
 * API interna que consulta el detalle/consumo de un DN (teléfono) específico.
 * Se utiliza para capturar el estado ANTES y DESPUÉS del reproceso del pago.
 */

// Endpoint para consultar el detalle de consumo por DN (teléfono)
const API_DETALLE_CONSUMO_URL =
  "https://uatserviciosweb.diri.mx/webresources/consultaConsumo";

// Headers para autenticación (reutiliza el mismo token que API MercadoPago)
const API_DETALLE_CONSUMO_HEADERS = {
  Authorization: "Bearer 2aRiOCGL9jnmibtVKTWN54zSsjJq",
};

/**
 * ===================== CONFIGURACIÓN BD RELACIONAL (MySQL) =====================
 * 
 * Define las tablas en PROD y UAT para las diferentes pasarelas de pago,
 * así como las tablas de negocio (recarga, preventa) para validaciones.
 */

// Tablas webhook para MercadoPago en PROD y UAT
const PROD_MP_TABLE = "diriprod.diri_webhook_mercadopago";
const UAT_MP_TABLE = "diriprod.diri_webhook_mercadopago";

// Tablas webhook para PayPal en PROD y UAT
const PROD_PAYPAL_TABLE = "diriprod.diri_webhook_paypal";
const UAT_PAYPAL_TABLE = "diriprod.diri_webhook_paypal";

// Tablas webhook para OpenPay en PROD y UAT
const PROD_OPENPAY_TABLE = "diriprod.diri_webhook_openpay";
const UAT_OPENPAY_TABLE = "diriprod.diri_webhook_openpay";

// Tablas de negocio para validación en UAT
const UAT_RECARGA_TABLE = "diriprod.diri_recarga";         // Operaciones tipo recarga
const UAT_PREVENTA_TABLE = "diriprod.diri_preventa";       // Operaciones tipo compra

// Timeout para consultas SQL (650 segundos = ~10.83 minutos)
const SQL_QUERY_TIMEOUT_MS = 650000;

// Timeouts para las APIs internas (15 segundos cada una)
const API2_TIMEOUT_MS = 15000;                      // procesanotificacionmercadopago
const API_PAYPAL_TIMEOUT_MS = 15000;                // paypalwebhook
const API_OPENPAY_TIMEOUT_MS = 15000;               // webhookopenpay
const API_DETALLE_CONSUMO_TIMEOUT_MS = 15000;       // consultaConsumo

/**
 * ===================== CONFIGURACIÓN MONGODB (ECOMMERCEDB) =====================
 * 
 * Configuración para acceso a MongoDB, donde se almacenan las órdenes de e-commerce.
 * Se utiliza para validar que la orden existe y tiene un estado de éxito después del pago.
 */

const MONGO_URI =
  "mongodb+srv://applications:qexpin-rugsuW-nupwi1@diri.kl13r.mongodb.net/";
const MONGO_DB_NAME = "ECOMMERCEDB";               // Base de datos
const MONGO_ORDERS_COLLECTION = "tbl_orders";     // Colección de órdenes

const mongoClient = new MongoClient(MONGO_URI);
let mongoClientReady = null;                        // Promise para lazy loading

/**
 * Obtiene la colección de órdenes de MongoDB.
 * Implementa lazy loading: conecta solo cuando se necesita.
 * 
 * @returns {Promise<Collection>} Colección de órdenes de MongoDB
 */
async function getOrdersCollection() {
  if (!mongoClientReady) {
    mongoClientReady = mongoClient.connect();
  }
  const client = await mongoClientReady;
  return client.db(MONGO_DB_NAME).collection(MONGO_ORDERS_COLLECTION);
}

/**
 * ======================= ENDPOINT PRINCIPAL /run-flow ==========================
 * 
 * POST /run-flow
 * 
 * Endpoint principal que simula el reproceso completo de un pago en UAT.
 * Maneja múltiples pasarelas de pago con lógicas específicas para cada una.
 * 
 * BODY ESPERADO (JSON):
 *   - folioCompra (string, required): Identificador único de la orden
 *   - brandNumber (string, optional): Marca/línea de negocio (requerido para MercadoPago)
 *   - gateway (string, optional): Pasarela de pago ('mercadopago', 'paypal', 'openpay')
 *   - tipoOperacion (string, optional): Tipo de operación ('recarga', 'compra')
 *   - purchaseDate (string, optional): Fecha en formato YYYY-MM-DD (requerido para PayPal)
 *   - dn (string, required): Número de teléfono (10 dígitos) para consulta de consumo
 */
app.post("/run-flow", async (req, res) => {
  // Extrae parámetros del body de la solicitud
  const { folioCompra, brandNumber, gateway, tipoOperacion, purchaseDate, dn } =
    req.body;
  
  // Array para almacenar logs detallados del flujo de ejecución
  const log = [];

  console.log("DEBUG /run-flow: inicio", {
    folioCompra,
    brandNumber,
    gateway,
    tipoOperacion,
    purchaseDate,
    dn,
  });

  // Variables para capturar cambios en consumo antes/después del reproceso
  let detalleConsumoAntes = null;        // Estado inicial de consumo del DN
  let detalleConsumoDespues = null;      // Estado final de consumo del DN
  let detalleConsumoDiff = null;         // Diferencias detectadas

  try {
    /**
     * ===================== VALIDACIONES BÁSICAS =====================
     * Valida que los parámetros recibidos tengan el formato y valores esperados.
     * Los errores aquí devuelven 400 Bad Request.
     */

    if (
      !folioCompra ||
      typeof folioCompra !== "string" ||
      folioCompra.length > 100
    ) {
      console.log("DEBUG /run-flow: VALIDACION_ERROR en folioCompra");
      return res.status(400).json({
        status: "VALIDACION_ERROR",
        mensaje: "folioCompra no es válido",
      });
    }

    if (brandNumber && !/^[0-9]{1,6}$/.test(brandNumber)) {
      console.log("DEBUG /run-flow: VALIDACION_ERROR en brandNumber");
      return res.status(400).json({
        status: "VALIDACION_ERROR",
        mensaje: "brandNumber debe ser numérico y de longitud razonable",
      });
    }

    if (!dn || !/^[0-9]{10}$/.test(dn)) {
      console.log("DEBUG /run-flow: VALIDACION_ERROR en dn");
      return res.status(400).json({
        status: "VALIDACION_ERROR",
        mensaje: "dn debe ser numérico de exactamente 10 dígitos",
      });
    }

    const gw = (gateway || "mercadopago").toLowerCase();
    const gatewaysPermitidos = ["mercadopago", "paypal", "openpay", "stripe"];
    if (!gatewaysPermitidos.includes(gw)) {
      console.log("DEBUG /run-flow: VALIDACION_ERROR en gateway", gw);
      return res.status(400).json({
        status: "VALIDACION_ERROR",
        mensaje: "Pasarela de pago no permitida",
      });
    }

    const tipo = (tipoOperacion || "recarga").toLowerCase();
    const tiposPermitidos = ["recarga", "compra"];
    if (!tiposPermitidos.includes(tipo)) {
      console.log("DEBUG /run-flow: VALIDACION_ERROR en tipoOperacion", tipo);
      return res.status(400).json({
        status: "VALIDACION_ERROR",
        mensaje: "Tipo de operación no permitido",
      });
    }

    // Validación extra para PayPal: purchaseDate requerido.
    if (gw === "paypal") {
      if (!purchaseDate || !/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) {
        console.log(
          "DEBUG /run-flow: VALIDACION_ERROR en purchaseDate para PayPal",
          {
            purchaseDate,
          }
        );
        return res.status(400).json({
          status: "VALIDACION_ERROR",
          mensaje:
            "Para PayPal se requiere purchaseDate en formato YYYY-MM-DD (ej. 2025-12-02).",
        });
      }
    }

    // ===================== LOG DE CONTEXTO =====================

    log.push(`Recibí folioCompra = ${folioCompra}`);
    log.push(`Marca / brandNumber = ${brandNumber || "no especificado"}`);
    log.push(`Pasarela seleccionada = ${gw}`);
    log.push(`Tipo de operación = ${tipo}`);
    log.push(`DN utilizado = ${dn}`);
    if (gw === "paypal") {
      log.push(`Fecha de compra (PayPal) = ${purchaseDate}`);
    }

    // ===================== API DETALLE CONSUMO (ANTES) =====================

    const marcaNumerica =
      brandNumber && /^[0-9]{1,6}$/.test(brandNumber)
        ? Number(brandNumber)
        : null;

    if (marcaNumerica && dn && /^[0-9]{10}$/.test(dn)) {
      const consumoAntesResult = await llamarApiDetalleConsumoDN({
        marca: marcaNumerica,
        dn,
        fase: "ANTES_DE_REPROCESO",
        log,
      });

      if (consumoAntesResult && consumoAntesResult.ok) {
        detalleConsumoAntes = consumoAntesResult.body;
      }
    } else {
      log.push(
        "No se llamó API detalle consumo DN (ANTES_DE_REPROCESO) porque marca o DN no son válidos."
      );
    }

    // ===================== RUTEO POR PASARELA =====================

    if (gw === "mercadopago") {
      // --------------------- FLUJO MERCADOPAGO ---------------------

      log.push(
        "Llamando API MercadoPago v1/payments/search (GET) con external_reference = folioCompra..."
      );
      console.log("DEBUG /run-flow: antes de axios.get a MercadoPago search", {
        url: API1_BASE_URL,
        folioCompra,
      });

      const api1Response = await axios.get(API1_BASE_URL, {
        headers: API1_DEFAULT_HEADERS,
        params: {
          external_reference: folioCompra,
        },
      });

      console.log("DEBUG /run-flow: después de axios.get a MercadoPago search");
      log.push("API MercadoPago v1/payments/search respondió correctamente.");

      const data = api1Response.data || {};
      const results = data.results || [];

      if (results.length === 0) {
        log.push("La búsqueda no devolvió pagos para esa external_reference");
        console.log("DEBUG /run-flow: SIN_RESULTADOS en MercadoPago");
        return res.status(404).json({
          status: "SIN_RESULTADOS",
          mensaje:
            "No se encontraron pagos para esa referencia en MercadoPago (v1/payments/search).",
          folioCompra,
          brandNumber,
          dn,
          gateway: gw,
          tipoOperacion: tipo,
          api1Response: data,
          log,
        });
      }

      const primerPago = results[0];
      const folioMercado = primerPago.id;
      log.push(`Folio de MercadoPago obtenido del primer pago = ${folioMercado}`);
      console.log("DEBUG /run-flow: folioMercado obtenido", { folioMercado });

      // SELECT EN PROD MP

      log.push(
        "Consultando BD PROD (diri_webhook_mercadopago) con folio_mercadopago..."
      );
      console.log("DEBUG /run-flow: antes de SELECT en PROD MP", {
        table: PROD_MP_TABLE,
        folioMercado,
      });

      const [rowsProd] = await prodPool.query({
        sql: `SELECT * FROM ${PROD_MP_TABLE} WHERE folio_mercadopago = ?`,
        values: [String(folioMercado)],
        timeout: SQL_QUERY_TIMEOUT_MS,
      });

      console.log("DEBUG /run-flow: después de SELECT en PROD MP", {
        rowsProdLength: rowsProd.length,
      });

      if (rowsProd.length === 0) {
        log.push(
          "No se encontró ningún registro en PROD para ese folio_mercadopago (diri_webhook_mercadopago)."
        );
        console.log("DEBUG /run-flow: SIN_REGISTRO_PROD");
        return res.status(404).json({
          status: "SIN_REGISTRO_PROD",
          mensaje:
            "No hay registro en PROD para ese pago en la tabla diri_webhook_mercadopago.",
          folioCompra,
          brandNumber,
          dn,
          gateway: gw,
          tipoOperacion: tipo,
          folioMercado,
          rowsProd: [],
          api1Response: data,
          log,
        });
      }

      const registroProd = rowsProd[0];
      log.push("Registro encontrado en PROD (diri_webhook_mercadopago).");
      console.log("DEBUG /run-flow: registroProd obtenido");

      // EXISTENCIA EN UAT MP

      log.push(
        "Verificando si ya existe registro en UAT (diri_webhook_mercadopago) para ese folio_mercadopago..."
      );
      console.log("DEBUG /run-flow: antes de SELECT existencia en UAT MP", {
        table: UAT_MP_TABLE,
        folioMercado,
      });

      const [rowsUatExistentes] = await uatPool.query({
        sql: `SELECT * FROM ${UAT_MP_TABLE} WHERE folio_mercadopago = ?`,
        values: [String(folioMercado)],
        timeout: SQL_QUERY_TIMEOUT_MS,
      });

      console.log("DEBUG /run-flow: después de SELECT existencia en UAT MP", {
        rowsUatExistentesLength: rowsUatExistentes.length,
      });

      if (rowsUatExistentes.length > 0) {
        log.push(
          "Registro ya existe en UAT para ese folio_mercadopago; se detiene el flujo (MercadoPago)."
        );
        console.log("DEBUG /run-flow: EXISTE_EN_UAT, no se inserta");
        return res.status(409).json({
          status: "EXISTE_EN_UAT",
          mensaje:
            "El registro ya existe en UAT. Favor de verificar e intentar de nuevo.",
          folioCompra,
          brandNumber,
          dn,
          gateway: gw,
          tipoOperacion: tipo,
          folioMercado,
          registroProd,
          registroUatExistente: rowsUatExistentes[0],
          api1Response: data,
          log,
        });
      }

      // INSERT EN UAT MP

      log.push(
        "No existía registro en UAT; insertando registro en UAT (diri_webhook_mercadopago)..."
      );
      console.log("DEBUG /run-flow: antes de INSERT en UAT MP", {
        table: UAT_MP_TABLE,
        folioMercado,
      });

      const [insertResult] = await uatPool.query({
        sql: `INSERT INTO ${UAT_MP_TABLE} SET ?`,
        values: [registroProd],
        timeout: SQL_QUERY_TIMEOUT_MS,
      });

      console.log("DEBUG /run-flow: después de INSERT en UAT MP", {
        insertId: insertResult.insertId,
        affectedRows: insertResult.affectedRows,
      });

      log.push(
        `Registro insertado en UAT con id = ${
          insertResult.insertId !== undefined
            ? insertResult.insertId
            : "sin autoincremento"
        }`
      );

      // UPDATE ESTATUS EN UAT MP

      log.push(
        "Actualizando estatus en UAT a 'PENDIENTE' para ese folio_mercadopago..."
      );
      console.log("DEBUG /run-flow: antes de UPDATE estatus en UAT MP", {
        table: UAT_MP_TABLE,
        folioMercado,
      });

      const [updateResult] = await uatPool.query({
        sql: `UPDATE ${UAT_MP_TABLE} SET estatus = ? WHERE folio_mercadopago = ?`,
        values: ["PENDIENTE", String(folioMercado)],
        timeout: SQL_QUERY_TIMEOUT_MS,
      });

      console.log("DEBUG /run-flow: después de UPDATE estatus en UAT MP", {
        changedRows: updateResult.changedRows,
        affectedRows: updateResult.affectedRows,
      });

      log.push(
        `Estatus actualizado a 'PENDIENTE' en UAT para ese folio_mercadopago (affectedRows = ${
          updateResult.affectedRows !== undefined
            ? updateResult.affectedRows
            : "desconocido"
        }).`
      );

      // METADATA PARA API 2

      const metadataRaw =
        registroProd &&
        Object.prototype.hasOwnProperty.call(registroProd, "metadata")
          ? registroProd.metadata
          : null;

      let metadataParsed = null;

      if (metadataRaw == null) {
        log.push(
          "Columna metadata no presente o nula en registro de PROD (MercadoPago)."
        );
      } else {
        log.push(
          "Metadata obtenida desde registroProd; lista para usar en API procesanotificacionmercadopago."
        );
        try {
          metadataParsed = JSON.parse(metadataRaw);
          log.push("Metadata parseada correctamente como JSON.");
        } catch (e) {
          log.push(
            "No se pudo parsear metadata como JSON; se devolverá como texto plano en metadataRaw."
          );
        }
      }

      console.log("DEBUG /run-flow: metadata preparada para API 2", {
        hasMetadataRaw: metadataRaw != null,
        metadataParsedType: metadataParsed ? typeof metadataParsed : "null",
      });

      if (!brandNumber) {
        log.push(
          "brandNumber es obligatorio para API procesanotificacionmercadopago (MercadoPago)."
        );
        console.log("DEBUG /run-flow: BRAND_REQUIRED_FOR_API2");
        return res.status(400).json({
          status: "BRAND_REQUIRED_FOR_API2",
          mensaje:
            "brandNumber es obligatorio para invocar la API procesanotificacionmercadopago.",
          folioCompra,
          brandNumber,
          dn,
          gateway: gw,
          tipoOperacion: tipo,
          folioMercado,
          metadataRaw,
          metadataParsed,
          log,
        });
      }

      if (!metadataParsed) {
        log.push(
          "Metadata no es un JSON válido; no se puede enviar body correcto a API procesanotificacionmercadopago."
        );
        console.log("DEBUG /run-flow: METADATA_INVALIDA_PARA_API2");
        return res.status(500).json({
          status: "METADATA_INVALIDA_PARA_API2",
          mensaje:
            "La metadata no es un JSON válido; no se puede construir el body para la API procesanotificacionmercadopago.",
          folioCompra,
          brandNumber,
          dn,
          gateway: gw,
          tipoOperacion: tipo,
          folioMercado,
          metadataRaw,
          metadataParsed,
          log,
        });
      }

      const api2Url = `${API2_BASE_URL}/${brandNumber}`;

      log.push(
        `Llamando API procesanotificacionmercadopago (POST) para marca ${brandNumber}...`
      );
      console.log("DEBUG /run-flow: antes de axios.post a API 2", {
        url: api2Url,
        brandNumber,
      });

      let api2Response;
      try {
        api2Response = await axios.post(api2Url, metadataParsed, {
          headers: API2_DEFAULT_HEADERS,
          timeout: API2_TIMEOUT_MS,
        });
      } catch (errorApi2) {
        log.push("ERROR en llamada a API procesanotificacionmercadopago: " + errorApi2.message);
        console.error("ERROR /run-flow API2:", errorApi2.message);

        if (errorApi2.code === "ECONNABORTED") {
          log.push("Timeout al llamar API procesanotificacionmercadopago.");
          console.error("DEBUG /run-flow: ERROR_API2_TIMEOUT");
          return res.status(504).json({
            status: "ERROR_API2_TIMEOUT",
            mensaje:
              "La API procesanotificacionmercadopago tardó más de lo esperado y se interrumpió por timeout.",
            folioCompra,
            brandNumber,
            dn,
            gateway: gw,
            tipoOperacion: tipo,
            folioMercado,
            metadataRaw,
            metadataParsed,
            log,
          });
        }

        if (errorApi2.response) {
          return res.status(errorApi2.response.status || 500).json({
            status: "ERROR_API2",
            mensaje:
              "Error al llamar API procesanotificacionmercadopago.",
            httpStatus: errorApi2.response.status,
            api2ErrorBody: errorApi2.response.data,
            folioCompra,
            brandNumber,
            dn,
            gateway: gw,
            tipoOperacion: tipo,
            folioMercado,
            metadataRaw,
            metadataParsed,
            log,
          });
        }

        return res.status(500).json({
          status: "ERROR_API2",
          mensaje:
            "Error de red al llamar API procesanotificacionmercadopago.",
          detalle: errorApi2.message,
          folioCompra,
          brandNumber,
          dn,
          gateway: gw,
          tipoOperacion: tipo,
          folioMercado,
          metadataRaw,
          metadataParsed,
          log,
        });
      }

      console.log("DEBUG /run-flow: después de axios.post a API 2", {
        httpStatus: api2Response.status,
      });

      const api2Data = api2Response.data || {};
      const codRespuestaApi2 = api2Data.codRespuesta || null;
      const detalleApi2 = api2Data.detalle || null;

      log.push(
        `API procesanotificacionmercadopago respondió con status HTTP ${api2Response.status}, codRespuesta = ${codRespuestaApi2}, detalle = ${detalleApi2}`
      );

      if (
        api2Response.status !== 200 ||
        codRespuestaApi2 !== "OK" ||
        detalleApi2 !== "SE PROCESO CON EXITO LA PETICION"
      ) {
        console.log("DEBUG /run-flow: API2_RESPUESTA_NO_OK");
        return res.status(502).json({
          status: "API2_RESPUESTA_NO_OK",
          mensaje:
            "La API procesanotificacionmercadopago respondió pero sin codRespuesta OK o detalle esperado. Revisar contenido.",
          folioCompra,
          brandNumber,
          dn,
          gateway: gw,
          tipoOperacion: tipo,
          folioMercado,
          metadataRaw,
          metadataParsed,
          api2Response: api2Data,
          log,
        });
      }

      log.push(
        "API procesanotificacionmercadopago procesó la notificación con éxito (codRespuesta OK)."
      );
      console.log(
        "DEBUG /run-flow: flujo OK hasta API procesanotificacionmercadopago (MercadoPago)"
      );

      // Validaciones de negocio (recarga/preventa) y Mongo para MP

      await validarTablasNegocioUat({ tipo, folioCompra, log });

      const { mongoOrderFound, mongoOrder } =
        await validarEnMongoPorFolioCompra(folioCompra, log);

      console.log(
        "DEBUG /run-flow: flujo completado OK en UAT + API procesanotificacionmercadopago + validación MongoDB (MercadoPago)"
      );

      // API detalle consumo (DESPUES) + diff
      if (marcaNumerica && dn && /^[0-9]{10}$/.test(dn)) {
        const { detalleConsumoDespues: dcDesp, detalleConsumoDiff: dcDiff } =
          await consultarConsumoDespuesYCalcularDiff({
            marca: marcaNumerica,
            dn,
            detalleConsumoAntes,
            log,
          });
        detalleConsumoDespues = dcDesp;
        detalleConsumoDiff = dcDiff;
      }

      return res.json({
        status: "OK",
        mensaje:
          "Flujo MercadoPago ejecutado → Folio Mercado obtenido → Registro encontrado en PROD → Insertado en UAT → Estatus actualizado a 'PENDIENTE' → Metadata de UAT preparada → Notificación procesada por API procesanotificacionmercadopago → Validación en tablas de negocio UAT y en MongoDB.",
        folioCompra,
        brandNumber,
        dn,
        gateway: gw,
        tipoOperacion: tipo,
        folioMercado,
        registroProd,
        registroUatInsertMeta: {
          insertId:
            insertResult.insertId !== undefined ? insertResult.insertId : null,
          affectedRows:
            insertResult.affectedRows !== undefined
              ? insertResult.affectedRows
              : null,
        },
        metadataRaw,
        metadataParsed,
        api2Response: api2Data,
        mongoOrderFound,
        mongoOrder,
        detalleConsumoAntesJson: detalleConsumoAntes,
        detalleConsumoDespuesJson: detalleConsumoDespues,
        detalleConsumoDiff,
        log,
      });
    }

    if (gw === "paypal") {
      // --------------------- FLUJO PAYPAL ---------------------

      log.push(
        "Iniciando flujo PayPal: consultas en webhook PROD → UAT + API paypalwebhook."
      );

      // 1) CONSULTA INICIAL EN PROD POR folioCompra EN METADATA

      log.push(
        "Consultando BD PROD PayPal (diri_webhook_paypal) por metadata que contenga folioCompra y fecha >= purchaseDate 00:00:00..."
      );
      console.log("DEBUG /run-flow: antes de SELECT PayPal por folioCompra", {
        table: PROD_PAYPAL_TABLE,
        folioCompra,
        purchaseDate,
      });

      const [rowsPaypalByFolio] = await prodPool.query({
        sql: `SELECT * FROM ${PROD_PAYPAL_TABLE} 
              WHERE fecha_registro >= ? 
                AND metadata LIKE ?`,
        values: [`${purchaseDate} 00:00:00`, `%${folioCompra}%`],
        timeout: SQL_QUERY_TIMEOUT_MS,
      });

      console.log("DEBUG /run-flow: después de SELECT PayPal por folioCompra", {
        rowsPaypalByFolioLength: rowsPaypalByFolio.length,
      });

      if (rowsPaypalByFolio.length === 0) {
        log.push(
          "No se encontró ningún registro en PROD PayPal para ese folioCompra y fecha indicada."
        );
        return res.status(404).json({
          status: "SIN_REGISTRO_PROD_PAYPAL",
          mensaje:
            "No hay registro en PROD para ese pago en la tabla diri_webhook_paypal (búsqueda por folioCompra).",
          folioCompra,
          brandNumber,
          dn,
          gateway: gw,
          tipoOperacion: tipo,
          purchaseDate,
          rowsPaypalByFolio: [],
          log,
        });
      }

      const primerRegistroFolio = rowsPaypalByFolio[0];

      const idrecurso =
        primerRegistroFolio &&
        Object.prototype.hasOwnProperty.call(primerRegistroFolio, "idrecurso")
          ? primerRegistroFolio.idrecurso
          : null;

      if (!idrecurso) {
        log.push(
          "El registro PayPal encontrado no contiene idrecurso; no se puede continuar el flujo."
        );
        return res.status(500).json({
          status: "SIN_IDRECURSO_PAYPAL",
          mensaje:
            "El registro PayPal encontrado no contiene idrecurso. Revisar datos en webhook PayPal PROD.",
          folioCompra,
          brandNumber,
          dn,
          gateway: gw,
          tipoOperacion: tipo,
          purchaseDate,
          primerRegistroFolio,
          log,
        });
      }

      log.push(`idrecurso PayPal obtenido desde primer registro = ${idrecurso}`);
      console.log("DEBUG /run-flow: idrecurso PayPal obtenido", { idrecurso });

      // 2) SEGUNDA CONSULTA EN PROD POR idrecurso EN METADATA

      log.push(
        "Consultando BD PROD PayPal (diri_webhook_paypal) por metadata que contenga idrecurso y fecha >= purchaseDate 00:00:00..."
      );
      console.log("DEBUG /run-flow: antes de SELECT PayPal por idrecurso", {
        table: PROD_PAYPAL_TABLE,
        idrecurso,
        purchaseDate,
      });

      const [rowsPaypalByIdrecurso] = await prodPool.query({
        sql: `SELECT * FROM ${PROD_PAYPAL_TABLE} 
              WHERE fecha_registro >= ? 
                AND metadata LIKE ?`,
        values: [`${purchaseDate} 00:00:00`, `%${idrecurso}%`],
        timeout: SQL_QUERY_TIMEOUT_MS,
      });

      console.log("DEBUG /run-flow: después de SELECT PayPal por idrecurso", {
        rowsPaypalByIdrecursoLength: rowsPaypalByIdrecurso.length,
      });

      if (rowsPaypalByIdrecurso.length === 0) {
        log.push(
          "No se encontró ningún registro en PROD PayPal para ese idrecurso y fecha indicada."
        );
        return res.status(404).json({
          status: "SIN_REGISTRO_PROD_PAYPAL",
          mensaje:
            "No hay registro en PROD para ese pago en la tabla diri_webhook_paypal (búsqueda por idrecurso).",
          folioCompra,
          brandNumber,
          dn,
          gateway: gw,
          tipoOperacion: tipo,
          purchaseDate,
          idrecurso,
          rowsPaypalByIdrecurso: [],
          log,
        });
      }

      const registroProdPaypal =
        rowsPaypalByIdrecurso.find(
          (row) =>
            row &&
            Object.prototype.hasOwnProperty.call(row, "evento") &&
            row.evento === "PAYMENT.CAPTURE.COMPLETED"
        ) || null;

      if (!registroProdPaypal) {
        log.push(
          "No se encontró ningún registro PayPal con evento PAYMENT.CAPTURE.COMPLETED para ese idrecurso."
        );
        return res.status(404).json({
          status: "SIN_EVENTO_COMPLETED_PAYPAL",
          mensaje:
            "No se encontró un evento PAYMENT.CAPTURE.COMPLETED para ese idrecurso en PayPal.",
          folioCompra,
          brandNumber,
          dn,
          gateway: gw,
          tipoOperacion: tipo,
          purchaseDate,
          idrecurso,
          rowsPaypalByIdrecurso,
          log,
        });
      }

      log.push(
        "Registro PayPal con evento PAYMENT.CAPTURE.COMPLETED encontrado en PROD."
      );
      console.log("DEBUG /run-flow: registroProdPaypal seleccionado", {
        idrecurso,
        evento: registroProdPaypal.evento,
      });

      // EXISTENCIA EN UAT PAYPAL

      log.push(
        "Verificando si ya existe registro PayPal en UAT para ese idrecurso..."
      );
      console.log("DEBUG /run-flow: antes de SELECT existencia en UAT PayPal", {
        table: UAT_PAYPAL_TABLE,
        idrecurso,
      });

      const [rowsUatPaypalExistentes] = await uatPool.query({
        sql: `SELECT * FROM ${UAT_PAYPAL_TABLE} WHERE idrecurso = ?`,
        values: [idrecurso],
        timeout: SQL_QUERY_TIMEOUT_MS,
      });

      console.log("DEBUG /run-flow: después de SELECT existencia en UAT PayPal", {
        rowsUatPaypalExistentesLength: rowsUatPaypalExistentes.length,
      });

      if (rowsUatPaypalExistentes.length > 0) {
        log.push(
          "Registro PayPal ya existe en UAT para ese idrecurso; se detiene el flujo de inserción."
        );
        return res.status(409).json({
          status: "EXISTE_EN_UAT_PAYPAL",
          mensaje:
            "El registro PayPal ya existe en UAT. Favor de verificar e intentar de nuevo.",
          folioCompra,
          brandNumber,
          dn,
          gateway: gw,
          tipoOperacion: tipo,
          purchaseDate,
          idrecurso,
          registroProdPaypal,
          registroUatPaypalExistente: rowsUatPaypalExistentes[0],
          log,
        });
      }

      // INSERT EN UAT PAYPAL

      log.push("No existía registro PayPal en UAT; insertando registro en UAT...");
      console.log("DEBUG /run-flow: antes de INSERT en UAT PayPal", {
        table: UAT_PAYPAL_TABLE,
        idrecurso,
      });

      const [insertResultPaypal] = await uatPool.query({
        sql: `INSERT INTO ${UAT_PAYPAL_TABLE} SET ?`,
        values: [registroProdPaypal],
        timeout: SQL_QUERY_TIMEOUT_MS,
      });

      console.log("DEBUG /run-flow: después de INSERT en UAT PayPal", {
        insertId: insertResultPaypal.insertId,
        affectedRows: insertResultPaypal.affectedRows,
      });

      log.push(
        `Registro PayPal insertado en UAT con id = ${
          insertResultPaypal.insertId !== undefined
            ? insertResultPaypal.insertId
            : "sin autoincremento"
        }`
      );

      // METADATA PAYPAL

      const metadataRawPaypal =
        registroProdPaypal &&
        Object.prototype.hasOwnProperty.call(registroProdPaypal, "metadata")
          ? registroProdPaypal.metadata
          : null;

      let metadataParsedPaypal = null;

      if (metadataRawPaypal == null) {
        log.push(
          "Columna metadata no presente o nula en registro PayPal de PROD."
        );
      } else {
        log.push(
          "Metadata PayPal obtenida desde registroProdPaypal; lista para usar en API paypalwebhook."
        );
        try {
          metadataParsedPaypal = JSON.parse(metadataRawPaypal);
          log.push("Metadata PayPal parseada correctamente como JSON.");
        } catch (e) {
          log.push(
            "No se pudo parsear metadata PayPal como JSON; se devolverá como texto plano en metadataRawPaypal."
          );
        }
      }

      console.log("DEBUG /run-flow: metadata preparada para API PayPal", {
        hasMetadataRawPaypal: metadataRawPaypal != null,
        metadataParsedPaypalType: metadataParsedPaypal
          ? typeof metadataParsedPaypal
          : "null",
      });

      if (!metadataParsedPaypal) {
        log.push(
          "Metadata PayPal no es un JSON válido; no se puede enviar body correcto a API paypalwebhook."
        );
        return res.status(500).json({
          status: "METADATA_INVALIDA_PARA_API_PAYPAL",
          mensaje:
            "La metadata PayPal no es un JSON válido; no se puede construir el body para la API paypalwebhook.",
          folioCompra,
          brandNumber,
          dn,
          gateway: gw,
          tipoOperacion: tipo,
          purchaseDate,
          idrecurso,
          metadataRawPaypal,
          metadataParsedPaypal,
          log,
        });
      }

      // LLAMADA A API PAYPAL WEBHOOK

      log.push("Llamando API paypalwebhook (POST)...");
      console.log("DEBUG /run-flow: antes de axios.post a API paypalwebhook", {
        url: API_PAYPAL_WEBHOOK_URL,
      });

      let apiPaypalResponse;
      try {
        apiPaypalResponse = await axios.post(
          API_PAYPAL_WEBHOOK_URL,
          metadataParsedPaypal,
          {
            headers: API_PAYPAL_WEBHOOK_HEADERS,
            timeout: API_PAYPAL_TIMEOUT_MS,
          }
        );
      } catch (errorApiPaypal) {
        log.push("ERROR en llamada a API paypalwebhook: " + errorApiPaypal.message);
        console.error(
          "ERROR /run-flow API_PAYPAL_WEBHOOK:",
          errorApiPaypal.message
        );

        if (errorApiPaypal.code === "ECONNABORTED") {
          log.push("Timeout al llamar API paypalwebhook.");
          return res.status(504).json({
            status: "ERROR_API_PAYPAL_TIMEOUT",
            mensaje:
              "La API paypalwebhook tardó más de lo esperado y se interrumpió por timeout.",
            folioCompra,
            brandNumber,
            dn,
            gateway: gw,
            tipoOperacion: tipo,
            purchaseDate,
            idrecurso,
            metadataRawPaypal,
            metadataParsedPaypal,
            log,
          });
        }

        if (errorApiPaypal.response) {
          return res.status(errorApiPaypal.response.status || 500).json({
            status: "ERROR_API_PAYPAL",
            mensaje: "Error al llamar API paypalwebhook.",
            httpStatus: errorApiPaypal.response.status,
            apiPaypalErrorBody: errorApiPaypal.response.data,
            folioCompra,
            brandNumber,
            dn,
            gateway: gw,
            tipoOperacion: tipo,
            purchaseDate,
            idrecurso,
            metadataRawPaypal,
            metadataParsedPaypal,
            log,
          });
        }

        return res.status(500).json({
          status: "ERROR_API_PAYPAL",
          mensaje: "Error de red al llamar API paypalwebhook.",
          detalle: errorApiPaypal.message,
          folioCompra,
          brandNumber,
          dn,
          gateway: gw,
          tipoOperacion: tipo,
          purchaseDate,
          idrecurso,
          metadataRawPaypal,
          metadataParsedPaypal,
          log,
        });
      }

      console.log("DEBUG /run-flow: después de axios.post a API paypalwebhook", {
        httpStatus: apiPaypalResponse.status,
      });

      const apiPaypalData = apiPaypalResponse.data || {};
      const codRespuestaPaypal = apiPaypalData.codRespuesta || null;
      const detallePaypal = apiPaypalData.detalle || null;

      log.push(
        `API paypalwebhook respondió con status HTTP ${apiPaypalResponse.status}, codRespuesta = ${codRespuestaPaypal}, detalle = ${detallePaypal}`
      );

      if (
        apiPaypalResponse.status !== 200 ||
        codRespuestaPaypal !== "OK" ||
        detallePaypal !== "SE PROCESO CON EXITO LA PETICION"
      ) {
        console.log("DEBUG /run-flow: API_PAYPAL_RESPUESTA_NO_OK");
        return res.status(502).json({
          status: "API_PAYPAL_RESPUESTA_NO_OK",
          mensaje:
            "La API paypalwebhook respondió pero sin codRespuesta OK o detalle esperado. Revisar contenido.",
          folioCompra,
          brandNumber,
          dn,
          gateway: gw,
          tipoOperacion: tipo,
          purchaseDate,
          idrecurso,
          metadataRawPaypal,
          metadataParsedPaypal,
          apiPaypalResponse: apiPaypalData,
          log,
        });
      }

      log.push(
        "API paypalwebhook procesó la notificación con éxito (codRespuesta OK)."
      );

      // Validaciones negocio + Mongo para PayPal (aceptando Entregado / PAID)

      await validarTablasNegocioUat({ tipo, folioCompra, log });

      const { mongoOrderFound, mongoOrder } =
        await validarEnMongoPorFolioCompra(folioCompra, log);

      // API detalle consumo (DESPUES) + diff
      if (marcaNumerica && dn && /^[0-9]{10}$/.test(dn)) {
        const { detalleConsumoDespues: dcDesp, detalleConsumoDiff: dcDiff } =
          await consultarConsumoDespuesYCalcularDiff({
            marca: marcaNumerica,
            dn,
            detalleConsumoAntes,
            log,
          });
        detalleConsumoDespues = dcDesp;
        detalleConsumoDiff = dcDiff;
      }

      return res.json({
        status: "OK",
        mensaje:
          "Flujo PayPal ejecutado → Webhook PROD encontrado → Insertado en UAT → Metadata preparada → Notificación procesada por API paypalwebhook → Validación en tablas de negocio UAT y en MongoDB.",
        folioCompra,
        brandNumber,
        dn,
        gateway: gw,
        tipoOperacion: tipo,
        purchaseDate,
        idrecurso,
        registroProdPaypal,
        registroUatInsertMetaPaypal: {
          insertId:
            insertResultPaypal.insertId !== undefined
              ? insertResultPaypal.insertId
              : null,
          affectedRows:
            insertResultPaypal.affectedRows !== undefined
              ? insertResultPaypal.affectedRows
              : null,
        },
        metadataRawPaypal,
        metadataParsedPaypal,
        apiPaypalResponse: apiPaypalData,
        mongoOrderFound,
        mongoOrder,
        detalleConsumoAntesJson: detalleConsumoAntes,
        detalleConsumoDespuesJson: detalleConsumoDespues,
        detalleConsumoDiff,
        log,
      });
    }

    if (gw === "openpay") {
      // --------------------- FLUJO OPENPAY COMPLETO ---------------------

      log.push(
        "Iniciando flujo OpenPay: webhook PROD → UAT → construcción JSON → API webhookopenpay → validaciones."
      );

      // PASO 1: SELECT EN PROD OPENPAY POR folio

      log.push("Consultando BD PROD OpenPay (diri_webhook_openpay) por folio...");
      console.log("DEBUG /run-flow: antes de SELECT en PROD OpenPay", {
        table: PROD_OPENPAY_TABLE,
        folioCompra,
      });

      const [rowsProdOpenpay] = await prodPool.query({
        sql: `SELECT * FROM ${PROD_OPENPAY_TABLE} WHERE folio = ?`,
        values: [folioCompra],
        timeout: SQL_QUERY_TIMEOUT_MS,
      });

      console.log("DEBUG /run-flow: después de SELECT en PROD OpenPay", {
        rowsProdOpenpayLength: rowsProdOpenpay.length,
      });

      if (rowsProdOpenpay.length === 0) {
        log.push(
          "No se encontró ningún registro OpenPay en PROD para ese folio (diri_webhook_openpay)."
        );
        return res.status(404).json({
          status: "SIN_REGISTRO_PROD_OPENPAY",
          mensaje:
            "No hay registro en PROD para ese folio en la tabla diri_webhook_openpay.",
          folioCompra,
          brandNumber,
          dn,
          gateway: gw,
          tipoOperacion: tipo,
          rowsProdOpenpay: [],
          log,
        });
      }

      const registroProdOpenpay = rowsProdOpenpay[0];
      log.push("Registro OpenPay encontrado en PROD.");

      // PASO 2: EXISTENCIA EN UAT OPENPAY

      log.push(
        "Verificando si ya existe registro OpenPay en UAT para ese folio..."
      );
      console.log("DEBUG /run-flow: antes de SELECT existencia en UAT OpenPay", {
        table: UAT_OPENPAY_TABLE,
        folioCompra,
      });

      const [rowsUatOpenpayExistentes] = await uatPool.query({
        sql: `SELECT * FROM ${UAT_OPENPAY_TABLE} WHERE folio = ?`,
        values: [folioCompra],
        timeout: SQL_QUERY_TIMEOUT_MS,
      });

      console.log("DEBUG /run-flow: después de SELECT existencia en UAT OpenPay", {
        rowsUatOpenpayExistentesLength: rowsUatOpenpayExistentes.length,
      });

      if (rowsUatOpenpayExistentes.length > 0) {
        log.push(
          "Registro OpenPay ya existe en UAT para ese folio; se detiene el flujo de inserción."
        );
        return res.status(409).json({
          status: "EXISTE_EN_UAT_OPENPAY",
          mensaje:
            "El registro OpenPay ya existe en UAT. Favor de verificar e intentar de nuevo.",
          folioCompra,
          brandNumber,
          dn,
          gateway: gw,
          tipoOperacion: tipo,
          registroProdOpenpay,
          registroUatOpenpayExistente: rowsUatOpenpayExistentes[0],
          log,
        });
      }

      // PASO 3: INSERT EN UAT OPENPAY

      log.push(
        "No existía registro OpenPay en UAT; insertando registro en UAT..."
      );
      console.log("DEBUG /run-flow: antes de INSERT en UAT OpenPay", {
        table: UAT_OPENPAY_TABLE,
        folioCompra,
      });

      const [insertResultOpenpay] = await uatPool.query({
        sql: `INSERT INTO ${UAT_OPENPAY_TABLE} SET ?`,
        values: [registroProdOpenpay],
        timeout: SQL_QUERY_TIMEOUT_MS,
      });

      console.log("DEBUG /run-flow: después de INSERT en UAT OpenPay", {
        insertId: insertResultOpenpay.insertId,
        affectedRows: insertResultOpenpay.affectedRows,
      });

      log.push(
        `Registro OpenPay insertado en UAT con id = ${
          insertResultOpenpay.insertId !== undefined
            ? insertResultOpenpay.insertId
            : "sin autoincremento"
        }`
      );

      // PASO 4: RECUPERAR METADATA DESDE UAT OPENPAY

      log.push(
        "Recuperando registro OpenPay desde UAT para obtener metadata después del insert..."
      );
      console.log("DEBUG /run-flow: antes de SELECT verificación en UAT OpenPay", {
        table: UAT_OPENPAY_TABLE,
        folioCompra,
      });

      const [rowsUatOpenpayAfterInsert] = await uatPool.query({
        sql: `SELECT * FROM ${UAT_OPENPAY_TABLE} WHERE folio = ?`,
        values: [folioCompra],
        timeout: SQL_QUERY_TIMEOUT_MS,
      });

      console.log("DEBUG /run-flow: después de SELECT verificación en UAT OpenPay", {
        rowsUatOpenpayAfterInsertLength: rowsUatOpenpayAfterInsert.length,
      });

      let metadataRawOpenpay = null;
      let metadataParsedOpenpay = null;

      if (
        rowsUatOpenpayAfterInsert.length > 0 &&
        Object.prototype.hasOwnProperty.call(rowsUatOpenpayAfterInsert[0], "metadata")
      ) {
        metadataRawOpenpay = rowsUatOpenpayAfterInsert[0].metadata;
        if (metadataRawOpenpay == null) {
          log.push(
            "Columna metadata en UAT OpenPay está nula o vacía después del insert."
          );
        } else {
          log.push(
            "Metadata obtenida desde registro OpenPay en UAT; se intenta parsear como JSON."
          );
          try {
            metadataParsedOpenpay = JSON.parse(metadataRawOpenpay);
            log.push("Metadata OpenPay en UAT parseada correctamente como JSON.");
          } catch (e) {
            log.push(
              "No se pudo parsear metadata OpenPay en UAT como JSON; se dejará en texto plano."
            );
          }
        }
      } else {
        log.push(
          "No se encontró registro OpenPay en UAT al verificar después del insert o la columna metadata no existe."
        );
      }

      // PASO 5: CONSTRUIR JSON PARA 4ª API A PARTIR DE metadataParsedOpenpay

      let openpayApi4Body = null;

      if (metadataParsedOpenpay && metadataParsedOpenpay.transaction) {
        const tx = metadataParsedOpenpay.transaction || {};
        const pm = tx.payment_method || {};
        const customer = tx.customer || {};

        const creationDate = tx.creation_date || null;
        const operationDate = tx.operation_date || null;
        const orderId = tx.order_id || null;
        const amount =
          typeof tx.amount === "number"
            ? tx.amount
            : tx.amount != null
            ? Number(tx.amount)
            : null;
        const reference = pm.reference || null;
        const email = customer.email || null;
        const phoneNumber = customer.phone_number || null;

        log.push(
          "Campos relevantes extraídos de metadata OpenPay: creation_date, operation_date, order_id, reference, amount, email, phone_number."
        );

        // Plantilla base del JSON de ejemplo; solo se sustituyen los campos indicados.
        const baseOpenpayTemplate = {
          type: "charge.succeeded",
          event_date: "2025-12-10T16:02:31-06:00",
          transaction: {
            id: "trqvchpibshq708tglsm",
            authorization: "087811",
            operation_type: "in",
            transaction_type: "charge",
            status: "completed",
            conciliated: false,
            creation_date: "2025-12-10T13:26:49-06:00",
            operation_date: "2025-12-10T16:02:30-06:00",
            description: null,
            error_message: null,
            order_id: "webp_1765403874237",
            amount: 50.0,
            currency: "MXN",
            payment_method: {
              type: "store",
              reference: "1010101344144225",
              barcode_url:
                "https://api.openpay.mx/barcode/1010101344144225?width=1&height=45&text=false",
              url_store:
                "https://api.openpay.mx/v1/ml8cfrcrzalre5r4eqeb/customers/734709707/trqvchpibshq708tglsm/store_confirm",
            },
            customer: {
              name: "Edgar",
              last_name: "DIRI-equipo",
              email: "evillegas@diri.mx",
              phone_number: "9987460467",
              address: {
                line1: "NA",
                line2: "NA",
                line3: "NA",
                state: "NA",
                city: "NA",
                postal_code: "NA",
                country_code: "NA",
              },
              creation_date: "2025-12-10T13:26:49-06:00",
              external_id: null,
              clabe: null,
            },
            fee: {
              amount: 9.14,
              tax: 1.4624,
              surcharge: null,
              base_commission: null,
              currency: "MXN",
            },
            method: "store",
          },
        };

        // Copia profunda de la plantilla base para construir el body final.
        openpayApi4Body = JSON.parse(JSON.stringify(baseOpenpayTemplate));

        // Sustitución únicamente de los campos indicados.
        if (creationDate) {
          openpayApi4Body.transaction.creation_date = creationDate;
          if (
            openpayApi4Body.transaction.customer &&
            typeof openpayApi4Body.transaction.customer === "object"
          ) {
            openpayApi4Body.transaction.customer.creation_date = creationDate;
          }
        }

        if (operationDate) {
          openpayApi4Body.transaction.operation_date = operationDate;
        }

        if (orderId) {
          openpayApi4Body.transaction.order_id = orderId;
        }

        if (amount !== null && !Number.isNaN(amount)) {
          openpayApi4Body.transaction.amount = amount;
        }

        if (reference) {
          if (
            openpayApi4Body.transaction.payment_method &&
            typeof openpayApi4Body.transaction.payment_method === "object"
          ) {
            openpayApi4Body.transaction.payment_method.reference = reference;
          }
        }

        if (email) {
          if (
            openpayApi4Body.transaction.customer &&
            typeof openpayApi4Body.transaction.customer === "object"
          ) {
            openpayApi4Body.transaction.customer.email = email;
          }
        }

        if (phoneNumber) {
          if (
            openpayApi4Body.transaction.customer &&
            typeof openpayApi4Body.transaction.customer === "object"
          ) {
            openpayApi4Body.transaction.customer.phone_number = phoneNumber;
          }
        }

        log.push(
          "JSON OpenPay para webhookopenpay construido con sustitución de los campos dinámicos indicados."
        );
      } else {
        log.push(
          "No se pudo construir JSON para webhookopenpay porque metadataParsedOpenpay es nulo o no contiene transaction."
        );
      }

      if (!openpayApi4Body) {
        return res.status(500).json({
          status: "METADATA_INVALIDA_PARA_API_OPENPAY",
          mensaje:
            "No se pudo construir el body JSON para webhookopenpay a partir de la metadata.",
          folioCompra,
          brandNumber,
          dn,
          gateway: gw,
          tipoOperacion: tipo,
          registroProdOpenpay,
          metadataRawOpenpay,
          metadataParsedOpenpay,
          log,
        });
      }

      // PASO 6: LLAMAR 4ª API webhookopenpay CON openpayApi4Body

      log.push("Llamando API webhookopenpay (POST) para reprocesar OpenPay...");
      console.log("DEBUG /run-flow: antes de axios.post a API webhookopenpay", {
        url: API_OPENPAY_WEBHOOK_URL,
      });

      let apiOpenpayResponse;
      try {
        apiOpenpayResponse = await axios.post(
          API_OPENPAY_WEBHOOK_URL,
          openpayApi4Body,
          {
            headers: API_OPENPAY_WEBHOOK_HEADERS,
            timeout: API_OPENPAY_TIMEOUT_MS,
          }
        );
      } catch (errorApiOpenpay) {
        log.push(
          "ERROR en llamada a API webhookopenpay: " + errorApiOpenpay.message
        );
        console.error(
          "ERROR /run-flow API_OPENPAY_WEBHOOK:",
          errorApiOpenpay.message
        );

        if (errorApiOpenpay.code === "ECONNABORTED") {
          log.push("Timeout al llamar API webhookopenpay.");
          return res.status(504).json({
            status: "ERROR_API_OPENPAY_TIMEOUT",
            mensaje:
              "La API webhookopenpay tardó más de lo esperado y se interrumpió por timeout.",
            folioCompra,
            brandNumber,
            dn,
            gateway: gw,
            tipoOperacion: tipo,
            registroProdOpenpay,
            metadataRawOpenpay,
            metadataParsedOpenpay,
            openpayApi4Body,
            log,
          });
        }

        if (errorApiOpenpay.response) {
          return res.status(errorApiOpenpay.response.status || 500).json({
            status: "ERROR_API_OPENPAY",
            mensaje: "Error al llamar API webhookopenpay.",
            httpStatus: errorApiOpenpay.response.status,
            apiOpenpayErrorBody: errorApiOpenpay.response.data,
            folioCompra,
            brandNumber,
            dn,
            gateway: gw,
            tipoOperacion: tipo,
            registroProdOpenpay,
            metadataRawOpenpay,
            metadataParsedOpenpay,
            openpayApi4Body,
            log,
          });
        }

        return res.status(500).json({
          status: "ERROR_API_OPENPAY",
          mensaje: "Error de red al llamar API webhookopenpay.",
          detalle: errorApiOpenpay.message,
          folioCompra,
          brandNumber,
          dn,
          gateway: gw,
          tipoOperacion: tipo,
          registroProdOpenpay,
          metadataRawOpenpay,
          metadataParsedOpenpay,
          openpayApi4Body,
          log,
        });
      }

      console.log("DEBUG /run-flow: después de axios.post a API webhookopenpay", {
        httpStatus: apiOpenpayResponse.status,
      });

      const apiOpenpayData = apiOpenpayResponse.data || {};
      const codRespuestaOpenpay = apiOpenpayData.codRespuesta || null;
      const detalleOpenpay = apiOpenpayData.detalle || null;

      log.push(
        `API webhookopenpay respondió con status HTTP ${apiOpenpayResponse.status}, codRespuesta = ${codRespuestaOpenpay}, detalle = ${detalleOpenpay}`
      );

      if (
        apiOpenpayResponse.status !== 200 ||
        codRespuestaOpenpay !== "OK" ||
        detalleOpenpay !== "SE PROCESO CON EXITO LA PETICION"
      ) {
        console.log("DEBUG /run-flow: API_OPENPAY_RESPUESTA_NO_OK");
        return res.status(502).json({
          status: "API_OPENPAY_RESPUESTA_NO_OK",
          mensaje:
            "La API webhookopenpay respondió pero sin codRespuesta OK o detalle esperado. Revisar contenido.",
          folioCompra,
          brandNumber,
          dn,
          gateway: gw,
          tipoOperacion: tipo,
          registroProdOpenpay,
          metadataRawOpenpay,
          metadataParsedOpenpay,
          openpayApi4Body,
          apiOpenpayResponse: apiOpenpayData,
          log,
        });
      }

      log.push(
        "API webhookopenpay procesó la notificación OpenPay con éxito (codRespuesta OK)."
      );

      // PASO 7: VALIDACIONES EN TABLAS DE NEGOCIO UAT Y EN MONGODB

      await validarTablasNegocioUat({ tipo, folioCompra, log });

      const { mongoOrderFound, mongoOrder } =
        await validarEnMongoPorFolioCompra(folioCompra, log);

      // API detalle consumo (DESPUES) + diff
      if (marcaNumerica && dn && /^[0-9]{10}$/.test(dn)) {
        const { detalleConsumoDespues: dcDesp, detalleConsumoDiff: dcDiff } =
          await consultarConsumoDespuesYCalcularDiff({
            marca: marcaNumerica,
            dn,
            detalleConsumoAntes,
            log,
          });
        detalleConsumoDespues = dcDesp;
        detalleConsumoDiff = dcDiff;
      }

      return res.json({
        status: "OK",
        mensaje:
          "Flujo OpenPay ejecutado → Webhook PROD encontrado → Insertado en UAT → Metadata recuperada → JSON para webhookopenpay construido → Notificación reprocesada por API webhookopenpay → Validación en tablas de negocio UAT y en MongoDB.",
        folioCompra,
        brandNumber,
        dn,
        gateway: gw,
        tipoOperacion: tipo,
        registroProdOpenpay,
        registroUatInsertOpenpay: {
          insertId:
            insertResultOpenpay.insertId !== undefined
              ? insertResultOpenpay.insertId
              : null,
          affectedRows:
            insertResultOpenpay.affectedRows !== undefined
              ? insertResultOpenpay.affectedRows
              : null,
        },
        metadataRawOpenpay,
        metadataParsedOpenpay,
        openpayApi4Body,
        apiOpenpayResponse: apiOpenpayData,
        mongoOrderFound,
        mongoOrder,
        detalleConsumoAntesJson: detalleConsumoAntes,
        detalleConsumoDespuesJson: detalleConsumoDespues,
        detalleConsumoDiff,
        log,
      });
    }

    // Pasarelas aún no implementadas (por ejemplo, stripe).
    log.push(
      `Pasarela ${gw} aún no implementada en el backend. Se devuelve GATEWAY_NO_IMPLEMENTADO.`
    );
    return res.status(400).json({
      status: "GATEWAY_NO_IMPLEMENTADO",
      mensaje:
        "Por ahora solo están implementados los flujos para MercadoPago, PayPal y OpenPay.",
      folioCompra,
      brandNumber,
      dn,
      gateway: gw,
      tipoOperacion: tipo,
      log,
    });
  } catch (error) {
    console.error("ERROR /run-flow:", error.message);
    console.error("ERROR /run-flow stack:", error.stack);
    log.push("ERROR en /run-flow: " + error.message);

    if (error.code === "PROTOCOL_SEQUENCE_TIMEOUT" || error.code === "ETIMEDOUT") {
      console.error("ERROR /run-flow: timeout en consulta SQL", {
        code: error.code,
        fatal: error.fatal,
      });
      return res.status(504).json({
        status: "ERROR_SQL_TIMEOUT",
        mensaje:
          "La consulta a la base de datos tardó más de lo esperado y se interrumpió por timeout.",
        sqlCode: error.code,
        detalle: error.message,
        log,
      });
    }

    if (error.response) {
      console.log("DEBUG /run-flow: error.response presente", {
        status: error.response.status,
      });
      return res.status(error.response.status || 500).json({
        status: "ERROR",
        mensaje: "Error al llamar una de las APIs externas o procesar su respuesta.",
        httpStatus: error.response.status,
        apiErrorBody: error.response.data,
        log,
      });
    }

    return res.status(500).json({
      status: "ERROR",
      mensaje: "Error de red o interno al ejecutar el flujo.",
      detalle: error.message,
      log,
    });
  }
});

// ===================== FUNCIONES AUXILIARES =====================

/**
 * Valida los registros de operaciones (recarga o compra) en las tablas de negocio de UAT.
 * 
 * @param {Object} options - Parámetros de configuración
 * @param {string} options.tipo - Tipo de operación ('recarga' o 'compra')
 * @param {string} options.folioCompra - Identificador de la orden
 * @param {Array} options.log - Array para registrar logs del proceso
 */
async function validarTablasNegocioUat({ tipo, folioCompra, log }) {
  try {
    if (tipo === "recarga") {
      log.push(
        "Validando en tabla de negocio UAT: diriprod.diri_recarga (recarga, estatus OK/PAGADO)..."
      );
      const [rowsRecarga] = await uatPool.query({
        sql: `SELECT * FROM ${UAT_RECARGA_TABLE} WHERE folio = ?`,
        values: [folioCompra],
        timeout: SQL_QUERY_TIMEOUT_MS,
      });

      if (rowsRecarga.length === 0) {
        log.push(
          "Advertencia: no se encontró registro de recarga en UAT para ese folio."
        );
      } else {
        const recarga = rowsRecarga[0];
        const estatus = recarga.estatus || recarga.status || null;
        if (!estatus || (estatus !== "OK" && estatus !== "PAGADO")) {
          log.push(
            `Error de negocio: recarga encontrada pero con estatus no exitoso (${estatus}).`
          );
        } else {
          log.push(
            `Recarga en UAT encontrada con estatus exitoso (${estatus}) para ese folio.`
          );
        }
      }
    } else if (tipo === "compra") {
      log.push(
        "Validando en tabla de negocio UAT: diriprod.diri_preventa (compra, status OK/PAGADO)..."
      );
      const [rowsPreventa] = await uatPool.query({
        sql: `SELECT * FROM ${UAT_PREVENTA_TABLE} WHERE folio = ?`,
        values: [folioCompra],
        timeout: SQL_QUERY_TIMEOUT_MS,
      });

      if (rowsPreventa.length === 0) {
        log.push(
          "Advertencia: no se encontró registro de compra (preventa) en UAT para ese folio."
        );
      } else {
        const preventa = rowsPreventa[0];
        const status = preventa.status || preventa.estatus || null;
        if (!status || (status !== "OK" && status !== "PAGADO")) {
          log.push(
            `Error de negocio: compra encontrada pero con status no exitoso (${status}).`
          );
        } else {
          log.push(
            `Compra en UAT encontrada con status exitoso (${status}) para ese folio.`
          );
        }
      }
    } else {
      log.push(
        `Tipo de operación desconocido para validación de tablas de negocio: ${tipo}`
      );
    }
  } catch (errorTablas) {
    log.push(
      "Error al validar tablas de negocio en UAT: " + errorTablas.message
    );
    console.error("ERROR validarTablasNegocioUat:", errorTablas.message);
  }
}

async function validarEnMongoPorFolioCompra(
  folioCompra,
  log,
  opciones = { estadosExito: ["Entregado", "PAID"] }
) {
  let mongoOrder = null;
  let mongoOrderFound = false;

  try {
    log.push(
      "Validando folioCompra en MongoDB ECOMMERCEDB.tbl_orders por patrón en _id..."
    );
    console.log("DEBUG /run-flow: antes de consulta MongoDB", {
      db: MONGO_DB_NAME,
      collection: MONGO_ORDERS_COLLECTION,
      folioCompra,
    });

    // Obtiene la colección de órdenes y busca por patrón en el _id
    const ordersCollection = await getOrdersCollection();
    const regex = new RegExp(folioCompra);  // Búsqueda flexible con regex
    mongoOrder = await ordersCollection.findOne({ _id: { $regex: regex } });

    if (mongoOrder) {
      mongoOrderFound = true;
      log.push("Orden encontrada en MongoDB para ese folioCompra.");
      const estadoMongo =
        mongoOrder.status || mongoOrder.estatus || mongoOrder.estado || null;
      if (
        estadoMongo &&
        Array.isArray(opciones.estadosExito) &&
        opciones.estadosExito.includes(estadoMongo)
      ) {
        log.push(
          `Estado en MongoDB considerado exitoso (${estadoMongo}) para ese folio.`
        );
      } else if (estadoMongo) {
        log.push(
          `Advertencia: estado en MongoDB (${estadoMongo}) no está dentro de los estados de éxito configurados.`
        );
      } else {
        log.push(
          "Advertencia: orden encontrada en MongoDB pero sin campo de estado reconocible."
        );
      }
      console.log("DEBUG /run-flow: MongoDB orden encontrada", {
        estadoMongo,
      });
    } else {
      log.push("No se encontró orden en MongoDB para ese folioCompra.");
      console.log(
        "DEBUG /run-flow: MongoDB sin resultados para ese folioCompra"
      );
    }
  } catch (mongoError) {
    log.push("Error al consultar MongoDB: " + mongoError.message);
    console.error("ERROR /run-flow Mongo:", mongoError.message);
  }

  return { mongoOrderFound, mongoOrder };
}

// ===== API detalle consumo DN (consultaConsumo) + diff genérico ===============

/**
 * Llamada a la API de detalle de consumo por DN.
 * 
 * @param {Object} options - Parámetros
 * @param {number} options.marca - Marca/línea de negocio
 * @param {string} options.dn - Número de teléfono (10 dígitos)
 * @param {string} options.fase - Fase del proceso ('ANTES_DE_REPROCESO' o 'DESPUES_DE_REPROCESO')
 * @param {Array} options.log - Array para registrar logs
 * @returns {Promise<Object>} Resultado con propiedades ok, httpStatus, body
 */
async function llamarApiDetalleConsumoDN({ marca, dn, fase, log }) {
  const body = {
    marca: Number(marca),
    dn: String(dn),
  };

  log.push(
    `Llamando API detalle consumo DN (${fase}) webresources/consultaConsumo (POST)...`
  );
  console.log("DEBUG /run-flow: antes de axios.post detalle consumo DN", {
    fase,
    url: API_DETALLE_CONSUMO_URL,
    body,
  });

  try {
    const respuesta = await axios.post(API_DETALLE_CONSUMO_URL, body, {
      headers: API_DETALLE_CONSUMO_HEADERS,
      timeout: API_DETALLE_CONSUMO_TIMEOUT_MS,
    });

    if (respuesta.status !== 200) {
      let bodyTexto;
      try {
        bodyTexto =
          typeof respuesta.data === "string"
            ? respuesta.data
            : JSON.stringify(respuesta.data);
      } catch (e) {
        bodyTexto = "[body no serializable]";
      }

      log.push(
        `Respuesta no 200 de API detalle consumo DN (${fase}): HTTP ${respuesta.status}, body: "${bodyTexto}"`
      );
      return {
        ok: false,
        httpStatus: respuesta.status,
        body: respuesta.data,
      };
    }

    log.push(
      `API detalle consumo DN (${fase}) respondió correctamente: HTTP ${respuesta.status}.`
    );

    return {
      ok: true,
      httpStatus: respuesta.status,
      body: respuesta.data,
    };
  } catch (err) {
    let bodyTexto = "";
    if (err.response) {
      try {
        bodyTexto =
          typeof err.response.data === "string"
            ? err.response.data
            : JSON.stringify(err.response.data);
      } catch (e) {
        bodyTexto = "[body de error no serializable]";
      }
      log.push(
        `ERROR al llamar API detalle consumo DN (${fase}): HTTP ${
          err.response.status
        }, body: "${bodyTexto}", mensaje: ${err.message}`
      );
    } else {
      log.push(
        `ERROR al llamar API detalle consumo DN (${fase}): ${err.message}`
      );
    }

    return {
      ok: false,
      httpStatus: err.response ? err.response.status : null,
      body: err.response ? err.response.data : null,
      error: err.message,
    };
  }
}

function computeJsonDiff(before, after) {
  // Array para almacenar las diferencias encontradas
  const diffs = [];

  /**
   * Determina el tipo de dato de un valor.
   * @param {*} valor - Valor a evaluar
   * @returns {string} Tipo del valor ('array', 'null', 'object', 'string', etc.)
   */
  function tipo(valor) {
    if (Array.isArray(valor)) return "array";
    if (valor === null) return "null";
    return typeof valor;
  }

  /**
   * Recorre recursivamente dos objetos/arrays y detecta diferencias.
   * @param {*} a - Valor antes
   * @param {*} b - Valor después
   * @param {string} path - Ruta del objeto actual (para construir el path completo)
   */
  function walk(a, b, path) {
    const tipoA = tipo(a);
    const tipoB = tipo(b);

    if (tipoA !== tipoB) {
      if (!(a === undefined && b === undefined)) {
        diffs.push({ path, antes: a, despues: b });
      }
      return;
    }

    if (tipoA === "object") {
      const keys = new Set([
        ...Object.keys(a || {}),
        ...Object.keys(b || {}),
      ]);
      for (const key of keys) {
        const newPath = path ? `${path}.${key}` : key;
        if (!(key in (a || {}))) {
          diffs.push({ path: newPath, antes: undefined, despues: b[key] });
        } else if (!(key in (b || {}))) {
          diffs.push({ path: newPath, antes: a[key], despues: undefined });
        } else {
          walk(a[key], b[key], newPath);
        }
      }
      return;
    }

    if (tipoA === "array") {
      const maxLen = Math.max(a.length, b.length);
      for (let i = 0; i < maxLen; i++) {
        const newPath = `${path}[${i}]`;
        if (i >= a.length) {
          diffs.push({ path: newPath, antes: undefined, despues: b[i] });
        } else if (i >= b.length) {
          diffs.push({ path: newPath, antes: a[i], despues: undefined });
        } else {
          walk(a[i], b[i], newPath);
        }
      }
      return;
    }

    // primitivos / null
    if (a !== b) {
      diffs.push({ path, antes: a, despues: b });
    }
  }

  walk(before, after, "");
  return diffs;
}

/**
 * Consulta el estado de consumo del DN DESPUÉS del reproceso y calcula las diferencias.
 * 
 * @param {Object} options - Parámetros
 * @param {number} options.marca - Marca/línea de negocio
 * @param {string} options.dn - Número de teléfono (10 dígitos)
 * @param {*} options.detalleConsumoAntes - Estado capturado ANTES del reproceso
 * @param {Array} options.log - Array para registrar logs
 * @returns {Promise<Object>} Objeto con detalleConsumoDespues y detalleConsumoDiff
 */
async function consultarConsumoDespuesYCalcularDiff({
  marca,
  dn,
  detalleConsumoAntes,
  log,
}) {
  if (!detalleConsumoAntes) {
    log.push(
      "No se calculará diff de detalle consumo DN porque no se obtuvo respuesta ANTES_DE_REPROCESO."
    );
    return {
      detalleConsumoDespues: null,
      detalleConsumoDiff: null,
    };
  }

  const consumoDespuesResult = await llamarApiDetalleConsumoDN({
    marca,
    dn,
    fase: "DESPUES_DE_REPROCESO",
    log,
  });

  if (!consumoDespuesResult || !consumoDespuesResult.ok) {
    log.push(
      "No se pudo obtener respuesta válida de API detalle consumo DN (DESPUES_DE_REPROCESO); no se calculará diff."
    );
    return {
      detalleConsumoDespues: consumoDespuesResult
        ? consumoDespuesResult.body
        : null,
      detalleConsumoDiff: null,
    };
  }

  const detalleConsumoDespues = consumoDespuesResult.body;
  const detalleConsumoDiff = computeJsonDiff(
    detalleConsumoAntes,
    detalleConsumoDespues
  );

  if (!detalleConsumoDiff || detalleConsumoDiff.length === 0) {
    log.push(
      "API detalle consumo DN (DESPUES_DE_REPROCESO) respondió igual que ANTES_DE_REPROCESO (sin diferencias detectadas)."
    );
  } else {
    log.push(
      `Se detectaron ${detalleConsumoDiff.length} diferencias en la respuesta de detalle consumo DN entre ANTES y DESPUES del reproceso.`
    );
  }

  return {
    detalleConsumoDespues,
    detalleConsumoDiff,
  };
}

// =========================== LEVANTAR SERVIDOR ================================

// Lee el puerto desde variable de entorno o usa el puerto 3000 por defecto
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});