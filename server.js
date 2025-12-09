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
const API2_DEFAULT_HEADERS = {
  Authorization: "Bearer 2aRiOCGL9jnmibtVKTWN54zSsjJq",
};

// ===================== CONFIGURACIÓN API 3 (WEBHOOK PAYPAL) =====================

// Endpoint del webhook PayPal.
const API3_PAYPAL_BASE_URL =
  "https://uatserviciosweb.diri.mx/webresources/paypalwebhook";

// Headers por defecto para API 3 PayPal.
const API3_PAYPAL_DEFAULT_HEADERS = {
  Authorization: "Bearer 123dagrtetad34gGDs!",
};

// ===================== CONFIGURACIÓN BD RELACIONAL (MySQL) =====================

// Tablas MercadoPago en PROD y UAT.
const PROD_TABLE_MP = "diriprod.diri_webhook_mercadopago";
const UAT_TABLE_MP = "diriprod.diri_webhook_mercadopago";

// Tablas PayPal en PROD y UAT.
const PROD_TABLE_PAYPAL = "diriprod.diri_webhook_paypal";
const UAT_TABLE_PAYPAL = "diriprod.diri_webhook_paypal";

// Timeout en milisegundos para consultas SQL.
const SQL_QUERY_TIMEOUT_MS = 650000; // 650 segundos = 10.83 minutos

// Timeout en milisegundos para llamadas a APIs.
const API2_TIMEOUT_MS = 15000;
const API3_PAYPAL_TIMEOUT_MS = 15000;

// ===================== CONFIGURACIÓN MONGODB (ECOMMERCEDB) =====================

// URI del clúster de MongoDB.
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

// ===================== HELPERS COMUNES (RECARGA/COMPRA Y MONGO) =====================

async function validarRecargaCompraEnUat(folioCompra, tipoOperacion, log) {
  const result = {
    performed: false,
    tipoOperacion: tipoOperacion || null,
    table: null,
    recordFound: false,
    statusField: null,
    statusValue: null,
    statusOk: false,
    error: null,
  };

  if (!folioCompra || !tipoOperacion) {
    return result;
  }

  const tipo = tipoOperacion.toLowerCase();
  if (tipo !== "recarga" && tipo !== "compra") {
    return result;
  }

  result.performed = true;

  let table;
  let statusColumn;
  if (tipo === "recarga") {
    table = "diriprod.diri_recarga";
    statusColumn = "estatus";
  } else {
    table = "diriprod.diri_preventa";
    statusColumn = "status";
  }

  result.table = table;
  result.statusField = statusColumn;

  try {
    log.push(
      `Validando en UAT tabla ${table} por folio = ${folioCompra} (tipoOperacion = ${tipo}).`
    );
    console.log("DEBUG /run-flow[RC]: antes de SELECT recarga/preventa en UAT", {
      table,
      folioCompra,
    });

    const [rows] = await uatPool.query({
      sql: `SELECT * FROM ${table} WHERE folio = ?`,
      values: [folioCompra],
      timeout: SQL_QUERY_TIMEOUT_MS,
    });

    console.log("DEBUG /run-flow[RC]: después de SELECT recarga/preventa en UAT", {
      table,
      rowsLength: rows.length,
    });

    if (rows.length === 0) {
      log.push(
        `Advertencia: no se encontró registro en ${table} para el folio indicado.`
      );
      return result;
    }

    result.recordFound = true;
    const registro = rows[0];
    const rawStatus = registro[statusColumn];
    result.statusValue = rawStatus;

    const normalized =
      typeof rawStatus === "string" ? rawStatus.trim().toUpperCase() : null;

    if (normalized === "OK" || normalized === "PAGADO") {
      result.statusOk = true;
      log.push(
        `Registro en ${table} encontrado con estado exitoso '${rawStatus}' (OK/PAGADO).`
      );
    } else {
      log.push(
        `Registro en ${table} encontrado pero con estado no exitoso '${rawStatus}' (se esperaba OK o PAGADO).`
      );
    }

    return result;
  } catch (err) {
    result.error = err.message;
    log.push(
      `Error al consultar tabla ${table} en UAT para recarga/compra: ${err.message}`
    );
    console.error("ERROR /run-flow[RC] consulta recarga/preventa UAT:", err.message);
    return result;
  }
}

async function validarMongoOrdenGenerico(folioCompra, log, contextoGateway) {
  const result = {
    performed: false,
    found: false,
    statusField: null,
    statusValue: null,
    statusOk: false,
    order: null,
    error: null,
  };

  if (!folioCompra) {
    return result;
  }

  result.performed = true;

  try {
    log.push(
      `Validando folioCompra en MongoDB ECOMMERCEDB.tbl_orders (${contextoGateway}) por patrón en _id...`
    );
    console.log("DEBUG /run-flow[MG]: antes de consulta MongoDB genérica", {
      db: MONGO_DB_NAME,
      collection: MONGO_ORDERS_COLLECTION,
      folioCompra,
      contextoGateway,
    });

    const ordersCollection = await getOrdersCollection();
    const regex = new RegExp(folioCompra);
    const order = await ordersCollection.findOne({ _id: { $regex: regex } });

    if (!order) {
      log.push("No se encontró orden en MongoDB para ese folioCompra.");
      console.log("DEBUG /run-flow[MG]: MongoDB sin resultados", {
        contextoGateway,
      });
      return result;
    }

    result.found = true;
    result.order = order;

    const rawStatus = order.status || order.estatus || null;
    result.statusField = Object.prototype.hasOwnProperty.call(order, "status")
      ? "status"
      : Object.prototype.hasOwnProperty.call(order, "estatus")
      ? "estatus"
      : null;
    result.statusValue = rawStatus;

    const normalized =
      typeof rawStatus === "string" ? rawStatus.trim().toLowerCase() : null;

    if (normalized === "entregado" || normalized === "paid") {
      result.statusOk = true;
      log.push(
        `Orden encontrada en MongoDB con status exitoso '${rawStatus}' (Entregado/PAID).`
      );
    } else {
      log.push(
        `Orden encontrada en MongoDB pero el status no es 'Entregado' ni 'PAID' (valor actual: '${rawStatus}').`
      );
    }

    console.log("DEBUG /run-flow[MG]: MongoDB orden encontrada", {
      contextoGateway,
      status: rawStatus,
    });

    return result;
  } catch (err) {
    result.error = err.message;
    log.push("Error al consultar MongoDB: " + err.message);
    console.error("ERROR /run-flow[MG] Mongo genérico:", err.message);
    return result;
  }
}

// ======================= ENDPOINT PRINCIPAL /run-flow =========================

app.post("/run-flow", async (req, res) => {
  const {
    folioCompra,
    brandNumber,
    gateway,
    tipoOperacion,
    purchaseDate, // usado para PayPal
  } = req.body;

  const log = [];

  console.log("DEBUG /run-flow: inicio", {
    folioCompra,
    brandNumber,
    gateway,
    tipoOperacion,
    purchaseDate,
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

    // ===================== BRANCH POR PASARELA =====================

    // -------------------------------------------------------------------------
    // PASARELA: MERCADOPAGO
    // -------------------------------------------------------------------------
    if (gw === "mercadopago") {
      // ================== PASO 1: API 1 (MERCADO PAGO) ==================

      log.push("Llamando API 1 (GET) a MercadoPago...");
      console.log("DEBUG /run-flow[MP]: antes de axios.get a MercadoPago", {
        url: API1_BASE_URL,
        folioCompra,
      });

      const api1Response = await axios.get(API1_BASE_URL, {
        headers: API1_DEFAULT_HEADERS,
        params: {
          external_reference: folioCompra,
        },
      });

      console.log("DEBUG /run-flow[MP]: después de axios.get a MercadoPago");
      log.push("API 1 respondió correctamente");

      const data = api1Response.data || {};
      const results = data.results || [];

      if (results.length === 0) {
        log.push("La búsqueda no devolvió pagos para esa external_reference");
        console.log("DEBUG /run-flow[MP]: SIN_RESULTADOS en MercadoPago");
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

      // Se toma el ID del pago de MercadoPago como folioMercado y se fuerza a string.
      const folioMercado = String(primerPago.id);

      log.push(`Folio de MercadoPago obtenido del primer pago = ${folioMercado}`);
      console.log("DEBUG /run-flow[MP]: folioMercado obtenido", { folioMercado });

      // ================== PASO 2: SELECT EN PROD (MySQL) ==================

      log.push("Consultando BD PROD con folioMercado...");
      console.log("DEBUG /run-flow[MP]: antes de SELECT en PROD", {
        table: PROD_TABLE_MP,
        folioMercado,
      });

      const [rowsProd] = await prodPool.query({
        sql: `SELECT * FROM ${PROD_TABLE_MP} WHERE folio_mercadopago = ?`,
        values: [folioMercado],
        timeout: SQL_QUERY_TIMEOUT_MS,
      });

      console.log("DEBUG /run-flow[MP]: después de SELECT en PROD", {
        rowsProdLength: rowsProd.length,
      });

      if (rowsProd.length === 0) {
        log.push("No se encontró ningún registro en PROD para ese folioMercado");
        console.log("DEBUG /run-flow[MP]: SIN_REGISTRO_PROD");
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
      console.log("DEBUG /run-flow[MP]: registroProd obtenido");

      // ================== PASO 3: EXISTENCIA EN UAT (MySQL) ==================

      log.push("Verificando si ya existe registro en UAT para ese folioMercado...");
      console.log("DEBUG /run-flow[MP]: antes de SELECT existencia en UAT", {
        table: UAT_TABLE_MP,
        folioMercado,
      });

      const [rowsUatExistentes] = await uatPool.query({
        sql: `SELECT * FROM ${UAT_TABLE_MP} WHERE folio_mercadopago = ?`,
        values: [folioMercado],
        timeout: SQL_QUERY_TIMEOUT_MS,
      });

      console.log("DEBUG /run-flow[MP]: después de SELECT existencia en UAT", {
        rowsUatExistentesLength: rowsUatExistentes.length,
      });

      if (rowsUatExistentes.length > 0) {
        log.push("Registro ya existe en UAT para ese folioMercado; se detiene el flujo.");
        console.log("DEBUG /run-flow[MP]: EXISTE_EN_UAT, no se inserta");
        return res.status(409).json({
          status: "EXISTE_EN_UAT",
          mensaje:
            "El registro ya existe en UAT. Favor de verificar e intentar de nuevo.",
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
      console.log("DEBUG /run-flow[MP]: antes de INSERT en UAT", {
        table: UAT_TABLE_MP,
        folioMercado,
      });

      const [insertResult] = await uatPool.query({
        sql: `INSERT INTO ${UAT_TABLE_MP} SET ?`,
        values: [registroProd],
        timeout: SQL_QUERY_TIMEOUT_MS,
      });

      console.log("DEBUG /run-flow[MP]: después de INSERT en UAT", {
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

      // ================== PASO 4B: UPDATE ESTATUS EN UAT ==================

      log.push("Actualizando estatus en UAT a 'PENDIENTE' para ese folioMercado...");
      console.log("DEBUG /run-flow[MP]: antes de UPDATE estatus en UAT", {
        table: UAT_TABLE_MP,
        folioMercado,
      });

      const [updateResult] = await uatPool.query({
        sql: `UPDATE ${UAT_TABLE_MP} SET estatus = ? WHERE folio_mercadopago = ?`,
        values: ["PENDIENTE", folioMercado],
        timeout: SQL_QUERY_TIMEOUT_MS,
      });

      console.log("DEBUG /run-flow[MP]: después de UPDATE estatus en UAT", {
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

      console.log("DEBUG /run-flow[MP]: metadata preparada para API 2", {
        hasMetadataRaw: metadataRaw != null,
        metadataParsedType: metadataParsed ? typeof metadataParsed : "null",
      });

      if (!brandNumber) {
        log.push(
          "brandNumber es obligatorio para API 2 procesanotificacionmercadopago."
        );
        console.log("DEBUG /run-flow[MP]: BRAND_REQUIRED_FOR_API2");
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
        console.log("DEBUG /run-flow[MP]: METADATA_INVALIDA_PARA_API2");
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
      console.log("DEBUG /run-flow[MP]: antes de axios.post a API 2", {
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
        console.error("ERROR /run-flow[MP] API2:", errorApi2.message);

        if (errorApi2.code === "ECONNABORTED") {
          log.push("Timeout al llamar API 2 procesanotificacionmercadopago.");
          console.error("DEBUG /run-flow[MP]: ERROR_API2_TIMEOUT");
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

      console.log("DEBUG /run-flow[MP]: después de axios.post a API 2", {
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
        console.log("DEBUG /run-flow[MP]: API2_RESPUESTA_NO_OK");
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
        "DEBUG /run-flow[MP]: flujo OK hasta API 2 procesanotificacionmercadopago"
      );

      // ================== PASO 7: VALIDACIÓN EN UAT (RECARGA / COMPRA) ==================

      const recargaCompraCheck = await validarRecargaCompraEnUat(
        folioCompra,
        tipo,
        log
      );

      // ================== PASO 8: VALIDACIÓN EN MONGODB (GENÉRICA) ==================

      const mongoCheck = await validarMongoOrdenGenerico(
        folioCompra,
        log,
        "MercadoPago"
      );

      if (!mongoCheck.found) {
        console.log("DEBUG /run-flow[MP]: MONGO_ORDER_NOT_FOUND_MP");
        return res.status(404).json({
          status: "MONGO_ORDER_NOT_FOUND_MP",
          mensaje:
            "Flujo MercadoPago llegó a API procesanotificacionmercadopago, pero no se encontró orden en MongoDB para ese folioCompra.",
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
              insertResult.affectedRows !== undefined
                ? insertResult.affectedRows
                : null,
          },
          metadataRaw,
          metadataParsed,
          recargaCompraCheck,
          mongoOrderFound: false,
          mongoOrderStatus: null,
          mongoOrder: null,
          api2Response: api2Data,
          log,
        });
      }

      if (!mongoCheck.statusOk) {
        console.log("DEBUG /run-flow[MP]: MONGO_ORDER_NOT_ENTREGADO_MP");
        return res.status(409).json({
          status: "MONGO_ORDER_NOT_ENTREGADO_MP",
          mensaje:
            "Flujo MercadoPago llegó a API procesanotificacionmercadopago, pero en MongoDB la orden no tiene status 'Entregado' ni 'PAID'.",
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
              insertResult.affectedRows !== undefined
                ? insertResult.affectedRows
                : null,
          },
          metadataRaw,
          metadataParsed,
          recargaCompraCheck,
          mongoOrderFound: true,
          mongoOrderStatus: mongoCheck.statusValue,
          mongoOrder: mongoCheck.order,
          api2Response: api2Data,
          log,
        });
      }

      console.log(
        "DEBUG /run-flow[MP]: flujo completado OK en UAT + API 2 + recarga/compra + validación MongoDB"
      );

      return res.json({
        status: "OK",
        mensaje:
          "Flujo MercadoPago ejecutado → Folio Mercado obtenido → Registro encontrado en PROD → Insertado en UAT → Estatus actualizado a 'PENDIENTE' → Metadata preparada → Notificación procesada por API 2 → validación recarga/compra en UAT → orden validada en MongoDB con status 'Entregado' o 'PAID'.",
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
            insertResult.affectedRows !== undefined
              ? insertResult.affectedRows
              : null,
        },
        metadataRaw,
        metadataParsed,
        recargaCompraCheck,
        mongoOrderFound: true,
        mongoOrderStatus: mongoCheck.statusValue,
        mongoOrder: mongoCheck.order,
        api2Response: api2Data,
        log,
      });
    }

    // -------------------------------------------------------------------------
    // PASARELA: PAYPAL
    // -------------------------------------------------------------------------

    if (gw === "paypal") {
      log.push(
        "Iniciando flujo PayPal (BD PROD → UAT base y CAPTURE → Webhook PayPal → MongoDB, usando folioCompra e idrecurso)."
      );

      if (!purchaseDate || !/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) {
        console.log("DEBUG /run-flow[PP]: VALIDACION_ERROR en purchaseDate", {
          purchaseDate,
        });
        return res.status(400).json({
          status: "VALIDACION_ERROR",
          mensaje:
            "Para PayPal se requiere purchaseDate en formato YYYY-MM-DD (ej. 2025-12-02).",
        });
      }

      const fechaInicio = `${purchaseDate} 00:00:00`;
      const likePatternFolio = `%${folioCompra}%`;

      // ================== PASO 1: SELECT BASE EN PROD PARA OBTENER idrecurso ==================

      log.push(
        `Consultando BD PROD (PayPal) para obtener registro base con fecha_registro >= '${fechaInicio}' y metadata LIKE '%${folioCompra}%'...`
      );
      console.log("DEBUG /run-flow[PP]: antes de SELECT base en PROD PayPal", {
        table: PROD_TABLE_PAYPAL,
        fechaInicio,
        likePatternFolio,
      });

      const [rowsProdPaypalBase] = await prodPool.query({
        sql: `SELECT * FROM ${PROD_TABLE_PAYPAL} WHERE fecha_registro >= ? AND metadata LIKE ?`,
        values: [fechaInicio, likePatternFolio],
        timeout: SQL_QUERY_TIMEOUT_MS,
      });

      console.log("DEBUG /run-flow[PP]: después de SELECT base en PROD PayPal", {
        rowsProdPaypalBaseLength: rowsProdPaypalBase.length,
      });

      if (rowsProdPaypalBase.length === 0) {
        log.push(
          "No se encontró ningún registro base en PROD (PayPal) para esa fecha y folioCompra en metadata."
        );
        console.log("DEBUG /run-flow[PP]: SIN_REGISTRO_PROD_PAYPAL_BASE");
        return res.status(404).json({
          status: "SIN_REGISTRO_PROD_PAYPAL_BASE",
          mensaje:
            "No hay registro en PROD (PayPal) para esa fecha y folioCompra dentro de metadata.",
          folioCompra,
          purchaseDate,
          brandNumber,
          gateway: gw,
          tipoOperacion: tipo,
          rowsProdPaypalBaseLength: 0,
          log,
        });
      }

      const registroBasePaypal = rowsProdPaypalBase[0];
      const idRecurso = registroBasePaypal.idrecurso;

      log.push("Registro base PayPal encontrado en PROD.");
      if (!idRecurso) {
        log.push(
          "El registro base en PROD (PayPal) no tiene idrecurso; no se puede continuar con la búsqueda por idrecurso."
        );
        console.log("DEBUG /run-flow[PP]: SIN_IDRECURSO_PROD_PAYPAL");
        return res.status(500).json({
          status: "SIN_IDRECURSO_PROD_PAYPAL",
          mensaje:
            "El registro base encontrado en PROD (PayPal) no contiene idrecurso. Revisar datos en la tabla.",
          folioCompra,
          purchaseDate,
          brandNumber,
          gateway: gw,
          tipoOperacion: tipo,
          registroBasePaypal,
          log,
        });
      }

      log.push(`idrecurso obtenido de PROD (PayPal) = ${idRecurso}.`);

      // ================== PASO 1B: INSERT DEL REGISTRO BASE EN UAT (PayPal) ==================

      const baseEvento = registroBasePaypal.evento || null;

      log.push(
        "Verificando si ya existe en UAT el registro base (folioCompra en metadata)..."
      );
      console.log("DEBUG /run-flow[PP]: antes de SELECT base en UAT PayPal", {
        table: UAT_TABLE_PAYPAL,
        likePatternFolio,
        baseEvento,
      });

      const whereBaseUat =
        baseEvento != null
          ? `metadata LIKE ? AND evento = ?`
          : `metadata LIKE ?`;

      const baseValuesUat =
        baseEvento != null ? [likePatternFolio, baseEvento] : [likePatternFolio];

      const [rowsUatPaypalBaseExistentes] = await uatPool.query({
        sql: `SELECT * FROM ${UAT_TABLE_PAYPAL} WHERE ${whereBaseUat}`,
        values: baseValuesUat,
        timeout: SQL_QUERY_TIMEOUT_MS,
      });

      console.log("DEBUG /run-flow[PP]: después de SELECT base en UAT PayPal", {
        rowsUatPaypalBaseExistentesLength: rowsUatPaypalBaseExistentes.length,
      });

      let insertBasePaypalResult = null;

      if (rowsUatPaypalBaseExistentes.length > 0) {
        log.push(
          "Registro base PayPal ya existe en UAT (con folioCompra en metadata); se continúa el flujo sin insertar base."
        );
        console.log("DEBUG /run-flow[PP]: EXISTE_BASE_EN_UAT_PAYPAL");
      } else {
        log.push(
          "No existía registro base PayPal en UAT; insertando registro base en UAT..."
        );
        console.log("DEBUG /run-flow[PP]: antes de INSERT base en UAT PayPal", {
          table: UAT_TABLE_PAYPAL,
        });

        const [insertBaseResult] = await uatPool.query({
          sql: `INSERT INTO ${UAT_TABLE_PAYPAL} SET ?`,
          values: [registroBasePaypal],
          timeout: SQL_QUERY_TIMEOUT_MS,
        });

        insertBasePaypalResult = insertBaseResult;

        console.log("DEBUG /run-flow[PP]: después de INSERT base en UAT PayPal", {
          insertId: insertBaseResult.insertId,
          affectedRows: insertBaseResult.affectedRows,
        });

        log.push(
          `Registro base PayPal insertado en UAT con id = ${
            insertBaseResult.insertId !== undefined
              ? insertBaseResult.insertId
              : "sin autoincremento"
          }`
        );
      }

      // ================== PASO 2: SELECT EN PROD POR idrecurso + evento ==================

      const likePatternId = `%${idRecurso}%`;

      log.push(
        "Buscando en PROD (PayPal) la primera fila con evento = 'PAYMENT.CAPTURE.COMPLETED' y metadata que contenga ese idrecurso..."
      );
      console.log("DEBUG /run-flow[PP]: antes de SELECT captura en PROD PayPal", {
        table: PROD_TABLE_PAYPAL,
        fechaInicio,
        likePatternId,
      });

      const [rowsProdPaypalCapture] = await prodPool.query({
        sql: `SELECT * FROM ${PROD_TABLE_PAYPAL}
              WHERE fecha_registro >= ?
                AND metadata LIKE ?
                AND evento = 'PAYMENT.CAPTURE.COMPLETED'
              ORDER BY fecha_registro ASC`,
        values: [fechaInicio, likePatternId],
        timeout: SQL_QUERY_TIMEOUT_MS,
      });

      console.log("DEBUG /run-flow[PP]: después de SELECT captura en PROD PayPal", {
        rowsProdPaypalCaptureLength: rowsProdPaypalCapture.length,
      });

      if (rowsProdPaypalCapture.length === 0) {
        log.push(
          "No se encontró en PROD (PayPal) ningún registro con evento PAYMENT.CAPTURE.COMPLETED para ese idrecurso."
        );
        console.log(
          "DEBUG /run-flow[PP]: SIN_EVENTO_CAPTURE_COMPLETED_PAYPAL"
        );
        return res.status(404).json({
          status: "SIN_EVENTO_CAPTURE_COMPLETED_PAYPAL",
          mensaje:
            "No hay registro en PROD (PayPal) con evento PAYMENT.CAPTURE.COMPLETED para ese idrecurso.",
          folioCompra,
          purchaseDate,
          brandNumber,
          gateway: gw,
          tipoOperacion: tipo,
          idRecurso,
          log,
        });
      }

      const registroProdPaypal = rowsProdPaypalCapture[0];
      log.push(
        "Registro en PROD (PayPal) encontrado para evento PAYMENT.CAPTURE.COMPLETED."
      );
      console.log("DEBUG /run-flow[PP]: registroProdPaypal (CAPTURE) obtenido");

      // ================== PASO 3: EXISTENCIA EN UAT (PayPal CAPTURE) ==================

      log.push(
        "Verificando si ya existe registro CAPTURE COMPLETED en UAT (PayPal) con metadata que contenga ese idrecurso..."
      );
      console.log("DEBUG /run-flow[PP]: antes de SELECT existencia CAPTURE en UAT PayPal", {
        table: UAT_TABLE_PAYPAL,
        likePatternId,
      });

      const [rowsUatPaypalExistentes] = await uatPool.query({
        sql: `SELECT * FROM ${UAT_TABLE_PAYPAL}
              WHERE metadata LIKE ?
                AND evento = 'PAYMENT.CAPTURE.COMPLETED'`,
        values: [likePatternId],
        timeout: SQL_QUERY_TIMEOUT_MS,
      });

      console.log("DEBUG /run-flow[PP]: después de SELECT existencia CAPTURE en UAT PayPal", {
        rowsUatPaypalExistentesLength: rowsUatPaypalExistentes.length,
      });

      if (rowsUatPaypalExistentes.length > 0) {
        log.push(
          "Registro CAPTURE COMPLETED ya existe en UAT (PayPal) para ese idrecurso; se detiene el flujo."
        );
        console.log("DEBUG /run-flow[PP]: EXISTE_EN_UAT_PAYPAL_CAPTURE");
        return res.status(409).json({
          status: "EXISTE_EN_UAT_PAYPAL",
          mensaje:
            "El registro CAPTURE COMPLETED ya existe en UAT para PayPal con ese idrecurso.",
          folioCompra,
          purchaseDate,
          brandNumber,
          gateway: gw,
          tipoOperacion: tipo,
          idRecurso,
          registroBasePaypal,
          registroProdPaypal,
          registroUatPaypalExistente: rowsUatPaypalExistentes[0],
          log,
        });
      }

      // ================== PASO 4: INSERT EN UAT (PayPal CAPTURE) ==================

      log.push(
        "No existía registro CAPTURE COMPLETED en UAT (PayPal); insertando registro CAPTURE en UAT..."
      );
      console.log("DEBUG /run-flow[PP]: antes de INSERT CAPTURE en UAT PayPal", {
        table: UAT_TABLE_PAYPAL,
      });

      const [insertCapturePaypalResult] = await uatPool.query({
        sql: `INSERT INTO ${UAT_TABLE_PAYPAL} SET ?`,
        values: [registroProdPaypal],
        timeout: SQL_QUERY_TIMEOUT_MS,
      });

      console.log("DEBUG /run-flow[PP]: después de INSERT CAPTURE en UAT PayPal", {
        insertId: insertCapturePaypalResult.insertId,
        affectedRows: insertCapturePaypalResult.affectedRows,
      });

      log.push(
        `Registro PayPal (CAPTURE COMPLETED) insertado en UAT con id = ${
          insertCapturePaypalResult.insertId !== undefined
            ? insertCapturePaypalResult.insertId
            : "sin autoincremento"
        }`
      );

      // ================== PASO 5: METADATA PARA API 3 (WEBHOOK PAYPAL) ==================

      const metadataPaypalRaw =
        registroProdPaypal &&
        Object.prototype.hasOwnProperty.call(registroProdPaypal, "metadata")
          ? registroProdPaypal.metadata
          : null;

      let metadataPaypalParsed = null;

      if (metadataPaypalRaw == null) {
        log.push(
          "Columna metadata en registro PayPal (CAPTURE COMPLETED) no presente o nula."
        );
      } else {
        log.push(
          "Metadata obtenida desde registroProdPaypal (CAPTURE COMPLETED); lista para usar en API 3 PayPal."
        );
        try {
          metadataPaypalParsed = JSON.parse(metadataPaypalRaw);
          log.push("Metadata de PayPal parseada correctamente como JSON.");
        } catch (e) {
          log.push(
            "No se pudo parsear metadata de PayPal como JSON; se devolverá como texto plano en metadataPaypalRaw."
          );
        }
      }

      console.log("DEBUG /run-flow[PP]: metadataPayPal preparada", {
        hasMetadataPaypalRaw: metadataPaypalRaw != null,
        metadataPaypalParsedType: metadataPaypalParsed
          ? typeof metadataPaypalParsed
          : "null",
      });

      if (!metadataPaypalParsed) {
        log.push(
          "Metadata PayPal no es un JSON válido; no se puede enviar body correcto a API 3 PayPal."
        );
        console.log("DEBUG /run-flow[PP]: METADATA_PAYPAL_INVALIDA_PARA_API3");
        return res.status(500).json({
          status: "METADATA_PAYPAL_INVALIDA_PARA_API3",
          mensaje:
            "La metadata de PayPal no es un JSON válido; no se puede construir el body para la API paypalwebhook.",
          folioCompra,
          purchaseDate,
          brandNumber,
          gateway: gw,
          tipoOperacion: tipo,
          idRecurso,
          metadataPaypalRaw,
          metadataPaypalParsed,
          log,
        });
      }

      // ================== PASO 6: API 3 (POST WEBHOOK PAYPAL) ==================

      const api3Url = API3_PAYPAL_BASE_URL;

      log.push("Llamando API 3 (POST) paypalwebhook con metadata PayPal...");
      console.log("DEBUG /run-flow[PP]: antes de axios.post a API 3 PayPal", {
        url: api3Url,
      });

      let api3Response;
      try {
        api3Response = await axios.post(api3Url, metadataPaypalParsed, {
          headers: API3_PAYPAL_DEFAULT_HEADERS,
          timeout: API3_PAYPAL_TIMEOUT_MS,
        });
      } catch (errorApi3) {
        log.push("ERROR en llamada a API 3 PayPal: " + errorApi3.message);
        console.error("ERROR /run-flow[PP] API3:", errorApi3.message);

        if (errorApi3.code === "ECONNABORTED") {
          log.push("Timeout al llamar API 3 paypalwebhook.");
          console.error("DEBUG /run-flow[PP]: ERROR_API3_TIMEOUT");
          return res.status(504).json({
            status: "ERROR_API3_TIMEOUT",
            mensaje:
              "La API paypalwebhook tardó más de lo esperado y se interrumpió por timeout.",
            folioCompra,
            purchaseDate,
            brandNumber,
            gateway: gw,
            tipoOperacion: tipo,
            idRecurso,
            metadataPaypalRaw,
            metadataPaypalParsed,
            log,
          });
        }

        if (errorApi3.response) {
          return res.status(errorApi3.response.status || 500).json({
            status: "ERROR_API3",
            mensaje: "Error al llamar API paypalwebhook.",
            httpStatus: errorApi3.response.status,
            api3ErrorBody: errorApi3.response.data,
            folioCompra,
            purchaseDate,
            brandNumber,
            gateway: gw,
            tipoOperacion: tipo,
            idRecurso,
            metadataPaypalRaw,
            metadataPaypalParsed,
            log,
          });
        }

        return res.status(500).json({
          status: "ERROR_API3",
          mensaje: "Error de red al llamar API paypalwebhook.",
          detalle: errorApi3.message,
          folioCompra,
          purchaseDate,
          brandNumber,
          gateway: gw,
          tipoOperacion: tipo,
          idRecurso,
          metadataPaypalRaw,
          metadataPaypalParsed,
          log,
        });
      }

      console.log("DEBUG /run-flow[PP]: después de axios.post a API 3 PayPal", {
        httpStatus: api3Response.status,
      });

      const api3Data = api3Response.data || {};
      const codRespuestaApi3 = api3Data.codRespuesta || null;
      const detalleApi3 = api3Data.detalle || null;

      log.push(
        `API 3 PayPal respondió con status HTTP ${api3Response.status}, codRespuesta = ${codRespuestaApi3}, detalle = ${detalleApi3}`
      );

      if (
        api3Response.status !== 200 ||
        codRespuestaApi3 !== "OK" ||
        detalleApi3 !== "SE PROCESO CON EXITO LA PETICION"
      ) {
        console.log("DEBUG /run-flow[PP]: API3_RESPUESTA_NO_OK");
        return res.status(502).json({
          status: "API3_RESPUESTA_NO_OK",
          mensaje:
            "La API paypalwebhook respondió pero sin codRespuesta OK o detalle esperado. Revisar contenido.",
          folioCompra,
          purchaseDate,
          brandNumber,
          gateway: gw,
          tipoOperacion: tipo,
          idRecurso,
          metadataPaypalRaw,
          metadataPaypalParsed,
          api3Response: api3Data,
          log,
        });
      }

      log.push("API 3 paypalwebhook procesó la notificación con éxito (codRespuesta OK).");

      // ================== PASO 7: VALIDACIÓN EN UAT (RECARGA / COMPRA) ==================

      const recargaCompraCheck = await validarRecargaCompraEnUat(
        folioCompra,
        tipo,
        log
      );

      // ================== PASO 8: VALIDACIÓN EN MONGODB (GENÉRICA) ==================

      const mongoCheck = await validarMongoOrdenGenerico(
        folioCompra,
        log,
        "PayPal"
      );

      if (!mongoCheck.found) {
        console.log("DEBUG /run-flow[PP]: MONGO_ORDER_NOT_FOUND_PAYPAL");
        return res.status(404).json({
          status: "MONGO_ORDER_NOT_FOUND_PAYPAL",
          mensaje:
            "Flujo PayPal llegó a API paypalwebhook, pero no se encontró orden en MongoDB para ese folioCompra.",
          folioCompra,
          purchaseDate,
          brandNumber,
          gateway: gw,
          tipoOperacion: tipo,
          idRecurso,
          registroBasePaypal,
          registroProdPaypal,
          registroUatBaseInsertMeta: insertBasePaypalResult
            ? {
                insertId:
                  insertBasePaypalResult.insertId !== undefined
                    ? insertBasePaypalResult.insertId
                    : null,
                affectedRows:
                  insertBasePaypalResult.affectedRows !== undefined
                    ? insertBasePaypalResult.affectedRows
                    : null,
              }
            : null,
          registroUatCaptureInsertMeta: {
            insertId:
              insertCapturePaypalResult.insertId !== undefined
                ? insertCapturePaypalResult.insertId
                : null,
            affectedRows:
              insertCapturePaypalResult.affectedRows !== undefined
                ? insertCapturePaypalResult.affectedRows
                : null,
          },
          metadataPaypalRaw,
          metadataPaypalParsed,
          api3Response: api3Data,
          recargaCompraCheck,
          mongoOrderFound: false,
          mongoOrderStatus: null,
          mongoOrder: null,
          log,
        });
      }

      if (!mongoCheck.statusOk) {
        console.log("DEBUG /run-flow[PP]: MONGO_ORDER_NOT_ENTREGADO_PAYPAL");
        return res.status(409).json({
          status: "MONGO_ORDER_NOT_ENTREGADO_PAYPAL",
          mensaje:
            "Flujo PayPal llegó hasta API paypalwebhook, pero en MongoDB la orden no tiene status 'Entregado' ni 'PAID'.",
          folioCompra,
          purchaseDate,
          brandNumber,
          gateway: gw,
          tipoOperacion: tipo,
          idRecurso,
          registroBasePaypal,
          registroProdPaypal,
          registroUatBaseInsertMeta: insertBasePaypalResult
            ? {
                insertId:
                  insertBasePaypalResult.insertId !== undefined
                    ? insertBasePaypalResult.insertId
                    : null,
                affectedRows:
                  insertBasePaypalResult.affectedRows !== undefined
                    ? insertBasePaypalResult.affectedRows
                    : null,
              }
            : null,
          registroUatCaptureInsertMeta: {
            insertId:
              insertCapturePaypalResult.insertId !== undefined
                ? insertCapturePaypalResult.insertId
                : null,
            affectedRows:
              insertCapturePaypalResult.affectedRows !== undefined
                ? insertCapturePaypalResult.affectedRows
                : null,
          },
          metadataPaypalRaw,
          metadataPaypalParsed,
          api3Response: api3Data,
          recargaCompraCheck,
          mongoOrderFound: true,
          mongoOrderStatus: mongoCheck.statusValue,
          mongoOrder: mongoCheck.order,
          log,
        });
      }

      console.log(
        "DEBUG /run-flow[PP]: flujo completado OK en PROD base + CAPTURE → UAT base + CAPTURE → paypalwebhook → recarga/compra UAT → MongoDB con status 'Entregado' o 'PAID'."
      );

      return res.json({
        status: "OK",
        mensaje:
          "Flujo PayPal ejecutado → registro base con folioCompra encontrado en PROD → copiado a UAT → idrecurso obtenido → registro PAYMENT.CAPTURE.COMPLETED encontrado en PROD → copiado a UAT → metadata enviada a API paypalwebhook → validación recarga/compra en UAT → orden validada en MongoDB con status 'Entregado' o 'PAID'.",
        folioCompra,
        purchaseDate,
        brandNumber,
        gateway: gw,
        tipoOperacion: tipo,
        idRecurso,
        registroBasePaypal,
        registroProdPaypal,
        registroUatBaseInsertMeta: insertBasePaypalResult
          ? {
              insertId:
                insertBasePaypalResult.insertId !== undefined
                  ? insertBasePaypalResult.insertId
                  : null,
              affectedRows:
                insertBasePaypalResult.affectedRows !== undefined
                  ? insertBasePaypalResult.affectedRows
                  : null,
            }
          : null,
        registroUatCaptureInsertMeta: {
          insertId:
            insertCapturePaypalResult.insertId !== undefined
              ? insertCapturePaypalResult.insertId
              : null,
          affectedRows:
            insertCapturePaypalResult.affectedRows !== undefined
              ? insertCapturePaypalResult.affectedRows
              : null,
        },
        metadataPaypalRaw,
        metadataPaypalParsed,
        api3Response: api3Data,
        recargaCompraCheck,
        mongoOrderFound: true,
        mongoOrderStatus: mongoCheck.statusValue,
        mongoOrder: mongoCheck.order,
        log,
      });
    }

    // -------------------------------------------------------------------------
    // CUALQUIER OTRA PASARELA NO IMPLEMENTADA
    // -------------------------------------------------------------------------
    log.push(`Pasarela ${gw} aún no implementada en el flujo backend.`);
    console.log("DEBUG /run-flow: GATEWAY_NO_IMPLEMENTADO", gw);
    return res.status(400).json({
      status: "GATEWAY_NO_IMPLEMENTADO",
      mensaje:
        "Por ahora solo están implementadas las pasarelas MercadoPago (completa) y PayPal (completa con webhook y validación en MongoDB).",
      folioCompra,
      brandNumber,
      gateway: gw,
      tipoOperacion: tipo,
      log,
    });
  } catch (error) {
    console.error("ERROR /run-flow:", error.message);
    console.error("ERROR /run-flow stack:", error.stack);
    const logError = [`ERROR en /run-flow: ${error.message}`];

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
        log: logError,
      });
    }

    if (error.response) {
      console.log("DEBUG /run-flow: error.response presente", {
        status: error.response.status,
      });
      return res.status(error.response.status || 500).json({
        status: "ERROR",
        mensaje: "Error al llamar alguna API externa o procesar su respuesta",
        httpStatus: error.response.status,
        apiErrorBody: error.response.data,
        log: logError,
      });
    }

    return res.status(500).json({
      status: "ERROR",
      mensaje: "Error de red o interno al ejecutar el flujo",
      detalle: error.message,
      log: logError,
    });
  }
});

// =========================== LEVANTAR SERVIDOR ================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});