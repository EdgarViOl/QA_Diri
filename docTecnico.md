# Documentación Técnica - Simulador de Pagos QA

## Índice

1. [Descripción General](#descripción-general)
2. [Arquitectura](#arquitectura)
3. [Configuración](#configuración)
4. [API Endpoint](#api-endpoint)
5. [Flujos por Pasarela](#flujos-por-pasarela)
6. [Funciones Auxiliares](#funciones-auxiliares)
7. [Manejo de Errores](#manejo-de-errores)
8. [Debugging y Logs](#debugging-y-logs)

---

## Descripción General

Este servidor Node.js/Express es una herramienta de QA que simula el reproceso completo de notificaciones de pagos desde múltiples pasarelas en el ambiente UAT (pruebas).

### Funcionalidades Principales

- ✅ Búsqueda de pagos en PROD usando criterios específicos por pasarela
- ✅ Inserción de registros en UAT para pruebas
- ✅ Procesamiento de notificaciones a través de APIs internas
- ✅ Validación en tablas de negocio (recarga, preventa)
- ✅ Validación en MongoDB (órdenes de e-commerce)
- ✅ Comparación de consumo antes/después del reproceso
- ✅ Logs detallados de cada paso

### Pasarelas Soportadas

1. **MercadoPago** - Busca por external_reference
2. **PayPal** - Busca por folioCompra e idrecurso
3. **OpenPay** - Busca por folio

---

## Arquitectura

### Stack Tecnológico

```
Node.js 14+ → Express 4.18+ → MySQL 2/Promise
                ↓
           Axios (HTTP client)
                ↓
           MongoDB Driver
```

### Flujo de Datos

```
Browser (Frontend)
    ↓
[POST /run-flow] (endpoint principal)
    ↓
Validaciones básicas
    ↓
API Detalle Consumo (ANTES)
    ↓
┌─ Ruteo por pasarela ─┬─ MercadoPago
│                      ├─ PayPal
│                      └─ OpenPay
│
└─ SELECT PROD → INSERT UAT → API Procesamiento → Validaciones
    ↓
Respuesta JSON con logs y detalles
```

---

## Configuración

### Archivos Clave

#### `server.js` (2084 líneas)

**Secciones principales:**

| Líneas | Sección | Descripción |
|--------|---------|-------------|
| 1-30 | Header | Importes y setup Express |
| 31-140 | Config APIs | URLs y headers de APIs externas |
| 141-160 | Config MySQL | Tablas y timeouts |
| 161-176 | Config MongoDB | URI, DB, colección |
| 177-220+ | Endpoint /run-flow | Lógica principal |

#### `db.js` (55 líneas)

Configura dos pools MySQL:
- `prodPool` - Conexión PRODUCCIÓN
- `uatPool` - Conexión UAT

#### Estructura de Directorios

```
server.js
  ├─ Configuración global (APIs, BD, MongoDB)
  ├─ app.post("/run-flow", ...)
  │   ├─ Validaciones básicas
  │   ├─ Logs de contexto
  │   ├─ API detalle consumo ANTES
  │   ├─ Flujo MercadoPago / PayPal / OpenPay
  │   └─ API detalle consumo DESPUÉS + diff
  │
  └─ Funciones auxiliares
      ├─ validarTablasNegocioUat()
      ├─ validarEnMongoPorFolioCompra()
      ├─ llamarApiDetalleConsumoDN()
      ├─ computeJsonDiff()
      └─ consultarConsumoDespuesYCalcularDiff()
```

---

## API Endpoint

### POST /run-flow

**Propósito:** Simular el reproceso completo de un pago

**Request Body:**

```javascript
{
  // Requeridos
  "folioCompra": "ORD20251211001",  // ID único de la orden
  "dn": "9987460467",               // Teléfono 10 dígitos

  // Opcionales (con defaults)
  "brandNumber": "101",             // Marca (requerido para MP)
  "gateway": "mercadopago",         // mercadopago|paypal|openpay
  "tipoOperacion": "recarga",       // recarga|compra
  "purchaseDate": "2025-12-11"      // YYYY-MM-DD (requerido para PayPal)
}
```

**Response (200 OK):**

```javascript
{
  "status": "OK",
  "mensaje": "Flujo MercadoPago ejecutado → ...",
  
  // Parámetros originales
  "folioCompra": "ORD20251211001",
  "brandNumber": "101",
  "dn": "9987460467",
  "gateway": "mercadopago",
  "tipoOperacion": "recarga",
  
  // Datos de PROD
  "folioMercado": 654321,
  "registroProd": { /* Registro completo */ },
  
  // Datos de inserción UAT
  "registroUatInsertMeta": {
    "insertId": 12345,
    "affectedRows": 1
  },
  
  // Metadata
  "metadataRaw": "{...}",           // String JSON sin parsear
  "metadataParsed": { /* ... */ },  // Objeto parseado
  
  // Respuesta de API procesamiento
  "api2Response": {
    "codRespuesta": "OK",
    "detalle": "SE PROCESO CON EXITO LA PETICION"
  },
  
  // Validación MongoDB
  "mongoOrderFound": true,
  "mongoOrder": { /* Datos de la orden */ },
  
  // Consumo antes/después
  "detalleConsumoAntesJson": { /* ... */ },
  "detalleConsumoDespuesJson": { /* ... */ },
  "detalleConsumoDiff": [
    {
      "path": "saldo.pesos",
      "antes": 100.50,
      "despues": 75.25
    },
    {
      "path": "servicios[0].estado",
      "antes": "activo",
      "despues": "cancelado"
    }
  ],
  
  // Log detallado
  "log": [
    "Recibí folioCompra = ORD20251211001",
    "Pasarela seleccionada = mercadopago",
    "Llamando API MercadoPago v1/payments/search...",
    // ... más logs
  ]
}
```

**Códigos de Error:**

| Status | HTTP | Causa |
|--------|------|-------|
| VALIDACION_ERROR | 400 | Parámetros inválidos |
| SIN_RESULTADOS | 404 | No hay pagos en MercadoPago |
| SIN_REGISTRO_PROD | 404 | Registro no existe en PROD |
| EXISTE_EN_UAT | 409 | Registro ya existe en UAT |
| ERROR_API2 | 502 | Error en API procesamiento |
| ERROR_SQL_TIMEOUT | 504 | Timeout en consulta SQL |
| ERROR | 500 | Error genérico interno |

---

## Flujos por Pasarela

### Flujo MercadoPago

```
1. VALIDACIONES
   ├─ Validar folioCompra (string, ≤100 chars)
   ├─ Validar brandNumber (1-6 dígitos, requerido)
   ├─ Validar dn (exactamente 10 dígitos)
   └─ Validar gateway

2. API DETALLE CONSUMO (ANTES)
   └─ GET /consultaConsumo + { marca, dn }

3. MERCADOPAGO SEARCH
   ├─ GET https://api.mercadopago.com/v1/payments/search
   │   └─ Param: external_reference = folioCompra
   ├─ Status: 200
   ├─ Parse: results[0].id → folioMercado
   └─ Si no hay resultados → Error SIN_RESULTADOS

4. CONSULTA PROD
   ├─ SELECT * FROM diri_webhook_mercadopago
   │   WHERE folio_mercadopago = folioMercado
   ├─ Si no hay resultados → Error SIN_REGISTRO_PROD
   └─ Parse: registroProd

5. VERIFICAR EXISTENCIA EN UAT
   ├─ SELECT * FROM diri_webhook_mercadopago (UAT)
   │   WHERE folio_mercadopago = folioMercado
   ├─ Si existe → Error EXISTE_EN_UAT (409)
   └─ Si no existe → Continuar

6. INSERT EN UAT
   ├─ INSERT INTO diri_webhook_mercadopago (UAT)
   │   SET registroProd
   └─ affectedRows > 0 ✓

7. UPDATE ESTATUS EN UAT
   ├─ UPDATE diri_webhook_mercadopago (UAT)
   │   SET estatus = 'PENDIENTE'
   │   WHERE folio_mercadopago = folioMercado
   └─ affectedRows > 0 ✓

8. PROCESAR METADATA
   ├─ Parse registroProd.metadata (JSON)
   ├─ Si falla parse → Error METADATA_INVALIDA_PARA_API2 (500)
   └─ metadataParsed

9. API PROCESAMIENTO
   ├─ POST https://uatserviciosweb.diri.mx/webresources/procesanotificacionmercadopago/{brandNumber}
   │   Header: Authorization: Bearer ...
   │   Body: metadataParsed
   ├─ Status: 200
   ├─ Response: { codRespuesta: "OK", detalle: "SE PROCESO CON EXITO LA PETICION" }
   └─ Si error → Error API2_RESPUESTA_NO_OK (502)

10. VALIDACIONES DE NEGOCIO
    ├─ Tabla diri_recarga (si tipoOperacion = "recarga")
    │   └─ SELECT by folio, verificar estatus OK/PAGADO
    ├─ Tabla diri_preventa (si tipoOperacion = "compra")
    │   └─ SELECT by folio, verificar status OK/PAGADO
    └─ Registra en logs (warnings si no coincide)

11. VALIDACION MONGODB
    ├─ findOne({ _id: { $regex: folioCompra } }) en tbl_orders
    ├─ Verifica status: "Entregado" o "PAID"
    └─ Registra encontrado/no encontrado en logs

12. API DETALLE CONSUMO (DESPUÉS)
    ├─ GET /consultaConsumo + { marca, dn }
    ├─ computeJsonDiff(ANTES, DESPUÉS)
    └─ Registra cambios encontrados

13. RESPUESTA
    └─ 200 + JSON con todos los detalles
```

### Flujo PayPal

```
1. VALIDACIONES
   ├─ Validar purchaseDate (requerido, YYYY-MM-DD)
   └─ Otros como MercadoPago

2. API DETALLE CONSUMO (ANTES)
   └─ GET /consultaConsumo + { marca, dn }

3. PRIMERA CONSULTA PROD - POR folioCompra
   ├─ SELECT * FROM diri_webhook_paypal (PROD)
   │   WHERE fecha_registro >= '{purchaseDate} 00:00:00'
   │   AND metadata LIKE '%{folioCompra}%'
   ├─ Si no hay → Error SIN_REGISTRO_PROD_PAYPAL (404)
   └─ Extrae: idrecurso = registros[0].idrecurso

4. SEGUNDA CONSULTA PROD - POR idrecurso
   ├─ SELECT * FROM diri_webhook_paypal (PROD)
   │   WHERE fecha_registro >= '{purchaseDate} 00:00:00'
   │   AND metadata LIKE '%{idrecurso}%'
   ├─ Si no hay → Error SIN_REGISTRO_PROD_PAYPAL (404)
   └─ Busca: evento = "PAYMENT.CAPTURE.COMPLETED"

5. VERIFICAR EXISTENCIA EN UAT
   ├─ SELECT * FROM diri_webhook_paypal (UAT)
   │   WHERE idrecurso = idrecurso
   ├─ Si existe → Error EXISTE_EN_UAT_PAYPAL (409)
   └─ Si no → Continuar

6. INSERT EN UAT
   ├─ INSERT INTO diri_webhook_paypal (UAT)
   │   SET registroProdPaypal
   └─ affectedRows > 0 ✓

7. PROCESAR METADATA
   ├─ Parse registroProdPaypal.metadata (JSON)
   └─ metadataParsedPaypal

8. API PAYPAL WEBHOOK
   ├─ POST https://uatserviciosweb.diri.mx/webresources/paypalwebhook
   │   Header: Authorization: Bearer ...
   │   Body: metadataParsedPaypal
   ├─ Status: 200
   ├─ Response: { codRespuesta: "OK", detalle: "SE PROCESO CON EXITO LA PETICION" }
   └─ Si error → Error API_PAYPAL_RESPUESTA_NO_OK (502)

9. VALIDACIONES DE NEGOCIO + MONGODB + CONSUMO
   ├─ Idem a MercadoPago pasos 10-12
   └─ Respuesta 200 + JSON
```

### Flujo OpenPay

```
1. VALIDACIONES + CONSUMO ANTES
   ├─ Idem a pasos anteriores
   └─ API detalle consumo (ANTES)

2. CONSULTA PROD
   ├─ SELECT * FROM diri_webhook_openpay (PROD)
   │   WHERE folio = folioCompra
   ├─ Si no hay → Error SIN_REGISTRO_PROD_OPENPAY (404)
   └─ registroProdOpenpay

3. VERIFICAR EXISTENCIA EN UAT
   ├─ SELECT * FROM diri_webhook_openpay (UAT)
   │   WHERE folio = folioCompra
   ├─ Si existe → Error EXISTE_EN_UAT_OPENPAY (409)
   └─ Si no → Continuar

4. INSERT EN UAT
   ├─ INSERT INTO diri_webhook_openpay (UAT)
   │   SET registroProdOpenpay
   └─ affectedRows > 0 ✓

5. RECUPERAR METADATA DESDE UAT
   ├─ SELECT * FROM diri_webhook_openpay (UAT)
   │   WHERE folio = folioCompra
   ├─ Parse metadata → metadataParsedOpenpay
   └─ Extrae: transaction, payment_method, customer

6. CONSTRUIR JSON PARA WEBHOOK
   ├─ Plantilla base (hardcoded) con estructura de event OpenPay
   ├─ Sustituciones dinámicas:
   │   ├─ creation_date
   │   ├─ operation_date
   │   ├─ order_id
   │   ├─ amount
   │   ├─ reference (payment_method)
   │   ├─ email (customer)
   │   └─ phone_number (customer)
   ├─ Si metadata es nula/invalid → Error METADATA_INVALIDA_PARA_API_OPENPAY (500)
   └─ openpayApi4Body

7. API WEBHOOKOPENPAY
   ├─ POST https://uatserviciosweb.diri.mx/webresources/webhookopenpay
   │   Header: {} (sin autorización especial)
   │   Body: openpayApi4Body
   ├─ Status: 200
   ├─ Response: { codRespuesta: "OK", detalle: "SE PROCESO CON EXITO LA PETICION" }
   └─ Si error → Error API_OPENPAY_RESPUESTA_NO_OK (502)

8. VALIDACIONES DE NEGOCIO + MONGODB + CONSUMO
   ├─ Idem a pasos anteriores
   └─ Respuesta 200 + JSON
```

---

## Funciones Auxiliares

### validarTablasNegocioUat({ tipo, folioCompra, log })

**Propósito:** Validar que existe registro en tablas de negocio con estado correcto

**Comportamiento:**
- Si `tipo = "recarga"` → Consulta `diri_recarga`
- Si `tipo = "compra"` → Consulta `diri_preventa`
- Busca por `folio = folioCompra`
- Valida estatus/status esté en [OK, PAGADO]
- Registra resultado en logs (no detiene flujo)

**Parámetros:**
| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| tipo | string | "recarga" o "compra" |
| folioCompra | string | ID de la orden |
| log | Array | Array para logs |

### validarEnMongoPorFolioCompra(folioCompra, log, opciones)

**Propósito:** Buscar orden en MongoDB y validar estado

**Implementación:**
- Usa regex en `_id`: `{ _id: { $regex: folioCompra } }`
- Busca estado en campos: `status`, `estatus`, `estado`
- Valida que esté en `opciones.estadosExito` (default: ["Entregado", "PAID"])
- No detiene flujo si no encuentra

**Retorna:**
```javascript
{
  mongoOrderFound: boolean,
  mongoOrder: { /* Document */ } | null
}
```

### llamarApiDetalleConsumoDN({ marca, dn, fase, log })

**Propósito:** Consultar consumo del DN en API interna

**Fases:**
- `"ANTES_DE_REPROCESO"` - Captura estado inicial
- `"DESPUES_DE_REPROCESO"` - Captura estado final

**Parámetros de Request:**
```javascript
{
  marca: 101,              // Numérico
  dn: "9987460467"         // String
}
```

**Retorna:**
```javascript
{
  ok: boolean,            // true si status 200
  httpStatus: number,     // 200, 500, etc.
  body: any,              // Respuesta del servidor
  error?: string          // Mensaje de error si aplica
}
```

### computeJsonDiff(before, after)

**Propósito:** Detectar diferencias entre dos objetos/arrays

**Función interna - walk(a, b, path):**
- Compara tipos de datos
- Itera objetos y arrays
- Compara primitivos
- Construye path completo (ej: "saldo.pesos[0]")

**Retorna:**
```javascript
[
  {
    path: "saldo.pesos",
    antes: 100.50,
    despues: 75.25
  },
  {
    path: "servicios[0]",
    antes: { id: 1, estado: "activo" },
    despues: { id: 1, estado: "cancelado" }
  }
]
```

### consultarConsumoDespuesYCalcularDiff({ marca, dn, detalleConsumoAntes, log })

**Propósito:** Orquestar consulta DESPUÉS y cálculo de diff

**Lógica:**
1. Si `detalleConsumoAntes` es null → Retorna (null, null)
2. Llama `llamarApiDetalleConsumoDN` con fase DESPUÉS
3. Si error → Registra en logs, retorna sin diff
4. Calcula `computeJsonDiff(ANTES, DESPUÉS)`
5. Si sin diferencias → Registra advertencia en logs

**Retorna:**
```javascript
{
  detalleConsumoDespues: any,
  detalleConsumoDiff: Array | null
}
```

---

## Manejo de Errores

### Estructura de Response de Error

```javascript
{
  "status": "ERROR_TYPE",
  "mensaje": "Descripción legible del error",
  "httpStatus": 400,              // Si aplica
  "detalle": "Información técnica",
  "sqlCode": "PROTOCOL_SEQUENCE_TIMEOUT",  // Si es SQL
  "apiErrorBody": { /* ... */ },  // Si es API error
  "log": [ /* ... */ ]            // Siempre incluido
}
```

### Tipos de Error Comunes

| Error | HTTP | Causa | Acción |
|-------|------|-------|--------|
| VALIDACION_ERROR | 400 | Parámetro inválido | Validar input |
| SIN_RESULTADOS | 404 | No existe en MercadoPago | Usar folio válido |
| SIN_REGISTRO_PROD | 404 | No existe en PROD BD | Verificar en SQL |
| EXISTE_EN_UAT | 409 | Ya fue procesado | Limpiar registro o cambiar folio |
| ERROR_SQL_TIMEOUT | 504 | Consulta tardó >650s | Optimizar query o aumentar timeout |
| ERROR_API2_TIMEOUT | 504 | API tardó >15s | Reintentar o contactar API owner |
| ERROR_API2 | 502 | API devolvió error | Ver apiErrorBody |
| METADATA_INVALIDA | 500 | Metadata no es JSON | Revisar formato en BD |

### Try-Catch Global

```javascript
try {
  // Flujo principal
} catch (error) {
  if (error.code === "PROTOCOL_SEQUENCE_TIMEOUT") {
    // SQL Timeout
    return res.status(504).json({ /* ... */ });
  }
  
  if (error.response) {
    // Error de API (tiene respuesta HTTP)
    return res.status(error.response.status).json({ /* ... */ });
  }
  
  // Error genérico
  return res.status(500).json({ /* ... */ });
}
```

---

## Debugging y Logs

### Console Logs (Server)

```
DEBUG /run-flow: inicio { folioCompra, ... }
DEBUG /run-flow: antes de axios.get a MercadoPago search
DEBUG /run-flow: folioMercado obtenido { folioMercado: 654321 }
DEBUG /run-flow: antes de SELECT en PROD MP { table, folioMercado }
DEBUG /run-flow: después de SELECT en PROD MP { rowsProdLength: 1 }
```

### Array Logs (Response)

Incluido en TODAS las respuestas, incluso errores:

```javascript
log: [
  "Recibí folioCompra = ORD20251211001",
  "Marca / brandNumber = 101",
  "Pasarela seleccionada = mercadopago",
  "Tipo de operación = recarga",
  "DN utilizado = 9987460467",
  "Llamando API MercadoPago v1/payments/search (GET) con external_reference...",
  "API MercadoPago v1/payments/search respondió correctamente.",
  "Folio de MercadoPago obtenido del primer pago = 654321",
  "Consultando BD PROD (diri_webhook_mercadopago) con folio_mercadopago...",
  "Después de SELECT en PROD MP",
  "Registro encontrado en PROD (diri_webhook_mercadopago).",
  // ... más logs
]
```

### Tips para Debugging

1. **Revisar logs array** - Sigue el flujo paso a paso
2. **Verificar console del servidor** - DEBUG messages
3. **Usar curl/Postman** - Prueba con diferentes parámetros
4. **Activar queries MySQL** - Usa `SHOW SLOW LOG`
5. **Monitorear APIs** - Check status de endpoints externos

### Ejemplo de Debugging Completo

```bash
# Terminal 1: Ejecutar servidor con logs
npm start

# Terminal 2: Hacer request
curl -X POST http://localhost:3000/run-flow \
  -H "Content-Type: application/json" \
  -d '{
    "folioCompra": "TEST12345",
    "brandNumber": "101",
    "gateway": "mercadopago",
    "tipoOperacion": "recarga",
    "dn": "9987460467"
  }'

# Terminal 1: Observar DEBUG logs y errores
```

---

## Conclusión

Este sistema proporciona un flujo completo y documentado para pruebas de integración de pagos. La arquitectura modular permite añadir nuevas pasarelas o validaciones fácilmente.

**Documentación actual:** 2084 líneas server.js + 55 líneas db.js
**Fecha:** Diciembre 2025
**Autor:** Villegas Olvera Edgar
