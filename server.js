// server.js
const express = require("express");
const path = require("path");
const axios = require("axios");
const { prodPool, uatPool } = require("./db");
const { MongoClient } = require("mongodb");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ===================== CONFIGURACIÓN API 1 (MERCADO PAGO) =====================

// Endpoint de búsqueda de pagos de MercadoPago.
const API1_BASE_URL = "https://api.mercadopago.com/v1/payments/search";

// Header de autorización para MercadoPago.
// En un entorno real se recomienda mover el token a una variable de entorno.
const API1_DEFAULT_HEADERS = {
  Authorization:
    "Bearer APP_USR-4048311431295047-110800-544ad44d3cb4a0e8e8880223481937b1-669403414",
};

// ===================== CONFIGURACIÓN API 2 (NOTIFICACIÓN MP) =====================

// Base URL de la API 2. La marca se concatena al final.
const API2_BASE_URL =
  "https://uatserviciosweb.diri.mx/webresources/procesanotificacionmercadopago";

// Headers por defecto para API 2.
// Si en el futuro se requiere api-key o Authorization, se agrega aquí.
const API2_DEFAULT_HEADERS = {
   Authorization:
    "Bearer 2aRiOCGL9jnmibtVKTWN54zSsjJq",
};

// ===================== CONFIGURACIÓN BD RELACIONAL (MySQL) =====================

// Tablas de PROD y UAT.
// Si el nombre de esquema o tabla cambia, se modifican estas constantes.
const PROD_TABLE = "diriprod.diri_webhook_mercadopago";
const UAT_TABLE = "diriprod.diri_webhook_mercadopago";

// Timeout en milisegundos para consultas SQL.
const SQL_QUERY_TIMEOUT_MS = 650000; // 650 segundos = 10.83 minutos

// Timeout en milisegundos para la API 2.
const API2_TIMEOUT_MS = 15000;

// ===================== CONFIGURACIÓN MONGODB (ECOMMERCEDB) =====================

// URI del clúster de MongoDB.
// En un entorno real se recomienda mover esto a una variable de entorno.
const MONGO_URI =
  "mongodb+srv://applications:qexpin-rugsuW-nupwi1@diri.kl13r.mongodb.net/";

// Nombre de la base de datos y colección donde se encuentra tbl_orders.
const MONGO_DB_NAME = "ECOMMERCEDB";
const MONGO_ORDERS_COLLECTION = "tbl_orders";

// Cliente global de MongoDB para reutilizar conexiones.
const mongoClient = new MongoClient(MONGO_URI);
let mongoClientReady = null;

async function getOrdersCollection() {
  if (!mongoClientReady) {
    mongoClientReady = mongoClient.connect();
  }
  const client = await mongoClientReady;
  return client.db(MONGO_DB_NAME).collection(MONGO_ORDERS_COLLECTION);
}

// ======================= ENDPOINT PRINCIPAL /run-flow =========================

app.post("/run-flow", async (req, res) => {
  const { folioCompra, brandNumber, gateway, tipoOperacion } = req.body;
  const log = [];

  console.log("DEBUG /run-flow: inicio", {
    folioCompra,
    brandNumber,
    gateway,
    tipoOperacion,
  });

  try {
    // ===================== VALIDACIONES BÁSICAS =====================

    if (!folioCompra || typeof folioCompra !== "string" || folioCompra.length > 100) {
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

    // ===================== LOG DE CONTEXTO =====================

    log.push(`Recibí folioCompra = ${folioCompra}`);
    log.push(`Marca / brandNumber = ${brandNumber || "no especificado"}`);
    log.push(`Pasarela seleccionada = ${gw}`);
    log.push(`Tipo de operación = ${tipo}`);

    // ===================== SELECCIÓN DE PASARELA =====================

    if (gw !== "mercadopago") {
      log.push(`Pasarela ${gw} aún no implementada en el flujo`);
      console.log("DEBUG /run-flow: GATEWAY_NO_IMPLEMENTADO", gw);
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

    // ================== PASO 1: API 1 (MERCADO PAGO) ==================

    log.push("Llamando API 1 (GET) a MercadoPago...");
    console.log("DEBUG /run-flow: antes de axios.get a MercadoPago", {
      url: API1_BASE_URL,
      folioCompra,
    });

    const api1Response = await axios.get(API1_BASE_URL, {
      headers: API1_DEFAULT_HEADERS,
      params: {
        external_reference: folioCompra,
      },
      // timeout: 10000, // opcional si se requiere límite en MP
    });

    console.log("DEBUG /run-flow: después de axios.get a MercadoPago");
    log.push("API 1 respondió correctamente");

    const data = api1Response.data || {};
    const results = data.results || [];

    if (results.length === 0) {
      log.push("La búsqueda no devolvió pagos para esa external_reference");
      console.log("DEBUG /run-flow: SIN_RESULTADOS en MercadoPago");
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

    // Se toma el ID del pago de MercadoPago como folioMercado.
    const folioMercado = primerPago.id;
    log.push(`Folio de MercadoPago obtenido del primer pago = ${folioMercado}`);
    console.log("DEBUG /run-flow: folioMercado obtenido", { folioMercado });

    // ================== PASO 2: SELECT EN PROD (MySQL) ==================

    log.push("Consultando BD PROD con folioMercado...");
    console.log("DEBUG /run-flow: antes de SELECT en PROD", {
      table: PROD_TABLE,
      folioMercado,
    });

    const [rowsProd] = await prodPool.query({
      sql: `SELECT * FROM ${PROD_TABLE} WHERE folio_mercadopago = ?`,
      values: [folioMercado],
      timeout: SQL_QUERY_TIMEOUT_MS,
    });

    console.log("DEBUG /run-flow: después de SELECT en PROD", {
      rowsProdLength: rowsProd.length,
    });

    if (rowsProd.length === 0) {
      log.push("No se encontró ningún registro en PROD para ese folioMercado");
      console.log("DEBUG /run-flow: SIN_REGISTRO_PROD");
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
    console.log("DEBUG /run-flow: registroProd obtenido");

    // ================== PASO 3: EXISTENCIA EN UAT (MySQL) ==================

    log.push("Verificando si ya existe registro en UAT para ese folioMercado...");
    console.log("DEBUG /run-flow: antes de SELECT existencia en UAT", {
      table: UAT_TABLE,
      folioMercado,
    });

    const [rowsUatExistentes] = await uatPool.query({
      sql: `SELECT * FROM ${UAT_TABLE} WHERE folio_mercadopago = ?`,
      values: [folioMercado],
      timeout: SQL_QUERY_TIMEOUT_MS,
    });

    console.log("DEBUG /run-flow: después de SELECT existencia en UAT", {
      rowsUatExistentesLength: rowsUatExistentes.length,
    });

    if (rowsUatExistentes.length > 0) {
      log.push("Registro ya existe en UAT para ese folioMercado; se detiene el flujo.");
      console.log("DEBUG /run-flow: EXISTE_EN_UAT, no se inserta");
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

    // ================== PASO 4: INSERT EN UAT (MySQL) ==================

    log.push("No existía registro en UAT; insertando registro en UAT...");
    console.log("DEBUG /run-flow: antes de INSERT en UAT", {
      table: UAT_TABLE,
      folioMercado,
    });

    const [insertResult] = await uatPool.query({
      sql: `INSERT INTO ${UAT_TABLE} SET ?`,
      values: [registroProd],
      timeout: SQL_QUERY_TIMEOUT_MS,
    });

    console.log("DEBUG /run-flow: después de INSERT en UAT", {
      insertId: insertResult.insertId,
      affectedRows: insertResult.affectedRows,
    });

    log.push(
      `Registro insertado en UAT con id = ${
        insertResult.insertId !== undefined ? insertResult.insertId : "sin autoincremento"
      }`
    );

    // ================== PASO 4B: UPDATE ESTATUS EN UAT ==================

    log.push("Actualizando estatus en UAT a 'PENDIENTE' para ese folioMercado...");
    console.log("DEBUG /run-flow: antes de UPDATE estatus en UAT", {
      table: UAT_TABLE,
      folioMercado,
    });

    const [updateResult] = await uatPool.query({
      sql: `UPDATE ${UAT_TABLE} SET estatus = ? WHERE folio_mercadopago = ?`,
      values: ["PENDIENTE", folioMercado],
      timeout: SQL_QUERY_TIMEOUT_MS,
    });

    console.log("DEBUG /run-flow: después de UPDATE estatus en UAT", {
      changedRows: updateResult.changedRows,
      affectedRows: updateResult.affectedRows,
    });

    log.push(
      `Estatus actualizado a 'PENDIENTE' en UAT para ese folioMercado (affectedRows = ${
        updateResult.affectedRows !== undefined
          ? updateResult.affectedRows
          : "desconocido"
      }).`
    );

    // ================== PASO 5: METADATA PARA API 2 ==================

    const metadataRaw =
      registroProd && Object.prototype.hasOwnProperty.call(registroProd, "metadata")
        ? registroProd.metadata
        : null;

    let metadataParsed = null;

    if (metadataRaw == null) {
      log.push("Columna metadata no presente o nula en registro de PROD.");
    } else {
      log.push("Metadata obtenida desde registroProd; lista para usar en API 2.");
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

    // Validar que se cuenta con lo necesario para API 2.
    if (!brandNumber) {
      log.push("brandNumber es obligatorio para API 2 procesanotificacionmercadopago.");
      console.log("DEBUG /run-flow: BRAND_REQUIRED_FOR_API2");
      return res.status(400).json({
        status: "BRAND_REQUIRED_FOR_API2",
        mensaje:
          "brandNumber es obligatorio para invocar la API 2 procesanotificacionmercadopago.",
        folioCompra,
        brandNumber,
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
        "Metadata no es un JSON válido; no se puede enviar body correcto a API 2."
      );
      console.log("DEBUG /run-flow: METADATA_INVALIDA_PARA_API2");
      return res.status(500).json({
        status: "METADATA_INVALIDA_PARA_API2",
        mensaje:
          "La metadata no es un JSON válido; no se puede construir el body para la API 2.",
        folioCompra,
        brandNumber,
        gateway: gw,
        tipoOperacion: tipo,
        folioMercado,
        metadataRaw,
        metadataParsed,
        log,
      });
    }

    // ================== PASO 6: API 2 (POST) ==================

    const api2Url = `${API2_BASE_URL}/${brandNumber}`;

    log.push(
      `Llamando API 2 (POST) procesanotificacionmercadopago para marca ${brandNumber}...`
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
      log.push("ERROR en llamada a API 2: " + errorApi2.message);
      console.error("ERROR /run-flow API2:", errorApi2.message);

      if (errorApi2.code === "ECONNABORTED") {
        log.push("Timeout al llamar API 2 procesanotificacionmercadopago.");
        console.error("DEBUG /run-flow: ERROR_API2_TIMEOUT");
        return res.status(504).json({
          status: "ERROR_API2_TIMEOUT",
          mensaje:
            "La API 2 procesanotificacionmercadopago tardó más de lo esperado y se interrumpió por timeout.",
          folioCompra,
          brandNumber,
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
          mensaje: "Error al llamar API 2 procesanotificacionmercadopago.",
          httpStatus: errorApi2.response.status,
          api2ErrorBody: errorApi2.response.data,
          folioCompra,
          brandNumber,
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
        mensaje: "Error de red al llamar API 2 procesanotificacionmercadopago.",
        detalle: errorApi2.message,
        folioCompra,
        brandNumber,
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
      `API 2 respondió con status HTTP ${api2Response.status}, codRespuesta = ${codRespuestaApi2}, detalle = ${detalleApi2}`
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
          "La API 2 respondió pero sin codRespuesta OK o detalle esperado. Revisar contenido.",
        folioCompra,
        brandNumber,
        gateway: gw,
        tipoOperacion: tipo,
        folioMercado,
        metadataRaw,
        metadataParsed,
        api2Response: api2Data,
        log,
      });
    }

    log.push("API 2 procesó la notificación con éxito (codRespuesta OK).");
    console.log(
      "DEBUG /run-flow: flujo OK hasta API 2 procesanotificacionmercadopago"
    );

    // ================== PASO 7: VALIDACIÓN EN MONGODB (ECOMMERCEDB.tbl_orders) ==================

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

      const ordersCollection = await getOrdersCollection();

      // Se usa una expresión regular con folioCompra tal como se indicó:
      // { _id: RegExp("<folioCompra>") }
      const regex = new RegExp(folioCompra);
      mongoOrder = await ordersCollection.findOne({ _id: { $regex: regex } });

      if (mongoOrder) {
        mongoOrderFound = true;
        log.push("Orden encontrada en MongoDB para ese folioCompra.");
        console.log("DEBUG /run-flow: MongoDB orden encontrada");
      } else {
        log.push("No se encontró orden en MongoDB para ese folioCompra.");
        console.log("DEBUG /run-flow: MongoDB sin resultados para ese folioCompra");
      }
    } catch (mongoError) {
      log.push("Error al consultar MongoDB: " + mongoError.message);
      console.error("ERROR /run-flow Mongo:", mongoError.message);
    }

    console.log(
      "DEBUG /run-flow: flujo completado OK en UAT + API 2 + validación MongoDB"
    );

    // ================== RESPUESTA FINAL DE ÉXITO ==================

    return res.json({
      status: "OK",
      mensaje:
        "Flujo MercadoPago ejecutado → Folio Mercado obtenido → Registro encontrado en PROD → Insertado en UAT → Estatus actualizado a 'PENDIENTE' → Metadata de UAT preparada → Notificación procesada por API 2 y Folio validado en MongoDB.",
      folioCompra,
      brandNumber,
      gateway: gw,
      tipoOperacion: tipo,
      folioMercado,
      registroProd,
      registroUatInsertMeta: {
        insertId:
          insertResult.insertId !== undefined ? insertResult.insertId : null,
        affectedRows:
          insertResult.affectedRows !== undefined ? insertResult.affectedRows : null,
      },
      metadataRaw,
      metadataParsed,
      api2Response: api2Data,
      mongoOrderFound,
      mongoOrder,
      log,
    });
  } catch (error) {
    console.error("ERROR /run-flow:", error.message);
    console.error("ERROR /run-flow stack:", error.stack);
    log.push("ERROR en /run-flow: " + error.message);

    // Manejo especial si el error es un timeout de consulta SQL.
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
        mensaje: "Error al llamar API 1 o procesar su respuesta",
        httpStatus: error.response.status,
        apiErrorBody: error.response.data,
        log,
      });
    }

    return res.status(500).json({
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