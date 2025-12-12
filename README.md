# Simulador de Pagos – Consola Web de Apoyo a QA
By: Villegas Olvera Edgar | QA Sr

Aplicación web (Node.js + Express + HTML/JS + MySQL + MongoDB) para apoyar pruebas manuales de reproceso
de notificaciones de pagos. Permite simular el flujo completo: búsqueda en pasarela, consulta en PROD,
inserción en UAT y reproceso mediante APIs internas.

---

## 1. Alcance

Pasarelas implementadas:
- **MercadoPago** (completo)
- **PayPal** (completo)
- **OpenPay** (completo)
- **Stripe** (aún no implementado)

Flujo general resumido:
1. Validar parámetros de entrada (folioCompra, dn, gateway, tipoOperacion, brandNumber, purchaseDate).
2. Consultar consumo ANTES (si marcaNumerica y dn son válidos).
3. Rutear hacia la pasarela y ejecutar búsqueda.
4. Localizar registro en PROD y opcionalmente insertar/verificar en UAT.
5. Reprocesar mediante API interna según pasarela.
6. Validar en tablas de negocio (diri_recarga, diri_preventa) y en MongoDB (tbl_orders).
7. Consultar consumo DESPUÉS y calcular diff.
8. Devolver respuesta con `log`, metadatos, registros y diffs.

---

## 2. Verificación de Consumo (ANTES / DESPUÉS / DIFF)

La API interna `consultaConsumo` permite capturar el estado del DN antes y después del reproceso.

**Pasos técnicos:**

1. **ANTES**: Se llama `llamarApiDetalleConsumoDN({ marca, dn, fase: 'ANTES_DE_REPROCESO' })`.
   - Resultado guardado en `detalleConsumoAntes`.

2. **Reproceso**: Se ejecutan las llamadas a APIs internas (procesanotificacionmercadopago, paypalwebhook, webhookopenpay).

3. **DESPUÉS**: Se llama `llamarApiDetalleConsumoDN({ marca, dn, fase: 'DESPUES_DE_REPROCESO' })`.
   - Resultado guardado en `detalleConsumoDespues`.

4. **Cálculo del DIFF**: Función `computeJsonDiff(detalleConsumoAntes, detalleConsumoDespues)`.
   - Compara recursivamente los dos objetos JSON (soporta arrays, objetos anidados, primitivos).
   - Devuelve un array con cambios detectados en formato `{ path, antes, despues }`.
   - Ej: `{ path: "saldo.monto", antes: 100, despues: 50 }`.

**Nota**: Si alguna llamada a consumo falla, el flujo continúa y el error se registra en `log`.

---

## 3. Flujos por Pasarela

### 3.1 MercadoPago

**Pasos:**
1. Validar que brandNumber está presente (requerido).
2. Llamar `GET /v1/payments/search` con `external_reference = folioCompra`.
3. Extraer `id` del primer pago (folioMercado).
4. Consultar PROD: `SELECT * FROM diriprod.diri_webhook_mercadopago WHERE folio_mercadopago = folioMercado`.
5. Verificar existencia en UAT (mismo folio).
6. Si no existe, INSERT en UAT y UPDATE estatus a 'PENDIENTE'.
7. Obtener metadata del registro, parsear como JSON.
8. Llamar `POST /procesanotificacionmercadopago/{brandNumber}` con metadata como body.
9. Esperar respuesta con `codRespuesta = "OK"` y `detalle = "SE PROCESO CON EXITO LA PETICION"`.
10. Validar en tablas de negocio y MongoDB.
11. Consultar consumo DESPUÉS y calcular diff.

**Tablas involucradas:**
- `diriprod.diri_webhook_mercadopago` (PROD)
- `diriuat.diri_webhook_mercadopago` (UAT)
- `diriprod.diri_recarga` (validación si tipoOperacion = recarga)
- `diriprod.diri_preventa` (validación si tipoOperacion = compra)
- `ECOMMERCEDB.tbl_orders` (MongoDB)

**Diagrama:**
```mermaid
flowchart TD
  A["Frontend<br/>(folioCompra, brandNumber, dn)"] --> B["GET /v1/payments/search<br/>(external_reference=folioCompra)"]
  B --> C["Obtener folioMercado<br/>(primer resultado)"]
  C --> D["SELECT diriprod.diri_webhook_mercadopago<br/>(folio_mercadopago=folioMercado)"]
  D --> E{Existe en UAT?}
  E -->|No| F["INSERT en diriuat.diri_webhook_mercadopago"]
  E -->|Sí| G["Usar registro UAT"]
  F --> H["Extraer metadata, parsear JSON"]
  G --> H
  H --> I["POST /procesanotificacionmercadopago/{brandNumber}"]
  I --> J["Validar en diri_recarga/diri_preventa y MongoDB"]
  J --> K["Consumo DESPUÉS + DIFF"]
  K --> L["Respuesta con log y resultados"]
```

---

### 3.2 PayPal

**Pasos:**
1. Validar que purchaseDate está presente en formato YYYY-MM-DD.
2. Consultar PROD (búsqueda 1): `SELECT * FROM diriprod.diri_webhook_paypal WHERE fecha_registro >= CONCAT(purchaseDate, ' 00:00:00') AND metadata LIKE CONCAT('%', folioCompra, '%') LIMIT 1`.
3. Del primer resultado, extraer `idrecurso`.
4. Consultar PROD (búsqueda 2): `SELECT * FROM diriprod.diri_webhook_paypal WHERE fecha_registro >= ... AND metadata LIKE CONCAT('%', idrecurso, '%')`.
5. Seleccionar el registro con `evento = 'PAYMENT.CAPTURE.COMPLETED'`.
6. Verificar existencia en UAT por `idrecurso`.
7. Si no existe, INSERT en UAT.
8. Obtener y parsear metadata como JSON.
9. Llamar `POST /paypalwebhook` con metadata como body.
10. Esperar respuesta con `codRespuesta = "OK"`.
11. Validar en tablas de negocio y MongoDB.
12. Consultar consumo DESPUÉS y calcular diff.

**Tablas involucradas:**
- `diriprod.diri_webhook_paypal` (PROD)
- `diriuat.diri_webhook_paypal` (UAT)
- `diriprod.diri_recarga` / `diriprod.diri_preventa` (validación)
- `ECOMMERCEDB.tbl_orders` (MongoDB)

**Diagrama:**
```mermaid
flowchart TD
  A["Frontend<br/>(folioCompra, purchaseDate, dn)"] --> B["SELECT diriprod.diri_webhook_paypal<br/>(fecha_registro >= purchaseDate,<br/>metadata LIKE folioCompra)"]
  B --> C["Obtener idrecurso del resultado"]
  C --> D["SELECT diriprod.diri_webhook_paypal<br/>(fecha_registro >= purchaseDate,<br/>metadata LIKE idrecurso)"]
  D --> E["Filtrar evento = 'PAYMENT.CAPTURE.COMPLETED'"]
  E --> F{Existe en UAT?}
  F -->|No| G["INSERT en diriuat.diri_webhook_paypal"]
  F -->|Sí| H["Usar registro UAT"]
  G --> I["Extraer metadata, parsear JSON"]
  H --> I
  I --> J["POST /paypalwebhook"]
  J --> K["Validar en diri_recarga/diri_preventa y MongoDB"]
  K --> L["Consumo DESPUÉS + DIFF"]
  L --> M["Respuesta con log y resultados"]
```

---

### 3.3 OpenPay

**Pasos:**
1. Consultar PROD: `SELECT * FROM diriprod.diri_webhook_openpay WHERE folio = folioCompra`.
2. Verificar existencia en UAT por folio.
3. Si no existe, INSERT en UAT.
4. SELECT nuevamente de UAT para obtener la metadata después del insert.
5. Parsear metadata: extraer campos transaction (creationDate, operationDate, orderId, amount, reference) y customer (email, phoneNumber).
6. Usar una plantilla base de JSON OpenPay (`type: "charge.succeeded"`) y sustituir solo los campos dinámicos extraídos.
7. Llamar `POST /webhookopenpay` con el JSON construido.
8. Esperar respuesta con `codRespuesta = "OK"`.
9. Validar en tablas de negocio y MongoDB.
10. Consultar consumo DESPUÉS y calcular diff.

**Tablas involucradas:**
- `diriprod.diri_webhook_openpay` (PROD)
- `diriuat.diri_webhook_openpay` (UAT)
- `diriprod.diri_recarga` / `diriprod.diri_preventa` (validación)
- `ECOMMERCEDB.tbl_orders` (MongoDB)

**Diagrama:**
```mermaid
flowchart TD
  A["Frontend<br/>(folioCompra, dn)"] --> B["SELECT diriprod.diri_webhook_openpay<br/>(folio=folioCompra)"]
  B --> C{Existe en UAT?}
  C -->|No| D["INSERT en diriuat.diri_webhook_openpay"]
  C -->|Sí| E["Usar registro UAT"]
  D --> F["SELECT diriuat.diri_webhook_openpay<br/>(obtener metadata)"]
  E --> F
  F --> G["Parsear metadata<br/>(extraer transaction, customer fields)"]
  G --> H["Construir JSON OpenPay<br/>(sustituir campos dinámicos)"]
  H --> I["POST /webhookopenpay"]
  I --> J["Validar en diri_recarga/diri_preventa y MongoDB"]
  J --> K["Consumo DESPUÉS + DIFF"]
  K --> L["Respuesta con log y resultados"]
```

---

## 4. Request/Response del Endpoint POST /run-flow

**Body esperado (JSON):**

```json
{
  "folioCompra": "string (requerido, máx 100 chars)",
  "dn": "string (requerido, exactamente 10 dígitos)",
  "gateway": "string (opcional, default 'mercadopago'; valores: 'mercadopago', 'paypal', 'openpay')",
  "tipoOperacion": "string (opcional, default 'recarga'; valores: 'recarga', 'compra')",
  "brandNumber": "string (opcional, requerido para MercadoPago; 1-6 dígitos)",
  "purchaseDate": "string (requerido para PayPal; formato YYYY-MM-DD)"
}
```

**Códigos HTTP y estados de respuesta:**

| Código | Estado | Descripción |
|--------|--------|-------------|
| 200 | OK | Flujo completado con éxito. |
| 400 | VALIDACION_ERROR | Parámetros inválidos. |
| 404 | SIN_RESULTADOS | No se encontró el pago. |
| 409 | EXISTE_EN_UAT | El registro ya existe en UAT. |
| 500 | ERROR_API | Error interno o en API externa. |
| 502 | API_RESPUESTA_NO_OK | La API interna respondió sin codRespuesta OK. |
| 504 | ERROR_TIMEOUT | Timeout en SQL o API. |

**Respuesta exitosa (200):**

```json
{
  "status": "OK",
  "mensaje": "Flujo ejecutado...",
  "folioCompra": "ORD12345678",
  "gateway": "mercadopago|paypal|openpay",
  "registroProd": {
    "folio_mercadopago": "12345678",
    "metadata": "{...}"
  },
  "registroUatInsertMeta": {
    "insertId": 123,
    "affectedRows": 1
  },
  "metadataRaw": "string JSON",
  "metadataParsed": { "campo1": "valor1" },
  "detalleConsumoAntesJson": {
    "ok": true,
    "body": { "saldo": { "monto": 100 } }
  },
  "detalleConsumoDespuesJson": {
    "ok": true,
    "body": { "saldo": { "monto": 50 } }
  },
  "detalleConsumoDiff": [
    { "path": "saldo.monto", "antes": 100, "despues": 50 }
  ],
  "mongoOrderFound": true,
  "mongoOrder": { "_id": "..." },
  "log": ["Paso 1...", "Paso 2...", "Paso 3..."]
}
```

---

## 5. Ejecución Local

**5.1. Configuración de variables de entorno**

Crear archivo `.env` en la raíz (no debe commitearse):

```env
# Base de datos PROD
DB_PROD_HOST=localhost
DB_PROD_USER=root
DB_PROD_PASS=password
DB_PROD_NAME=diriprod

# Base de datos UAT
DB_UAT_HOST=localhost
DB_UAT_USER=root
DB_UAT_PASS=password
DB_UAT_NAME=diriuat

# MongoDB
MONGO_URI=mongodb+srv://applications:password@host.mongodb.net/
MONGO_DB_NAME=ECOMMERCEDB
MONGO_ORDERS_COLLECTION=tbl_orders

# APIs externas
MP_ACCESS_TOKEN=APP_USR-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
API2_AUTH_TOKEN=Bearer xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
PAYPAL_AUTH_TOKEN=Bearer xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
OPENPAY_AUTH_TOKEN=Bearer xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Puerto
PORT=3000
```

**5.2. Instalar dependencias**

```bash
npm install
```

**5.3. Ejecutar servidor**

```bash
node server.js
# o con nodemon (si existe en devDependencies)
npm run dev
```

El servidor escuchará en `http://localhost:3000`.

**5.4. Pruebas con curl**

MercadoPago:
```bash
curl -X POST http://localhost:3000/run-flow \
  -H "Content-Type: application/json" \
  -d '{
    "folioCompra": "ORD12345678",
    "dn": "9987460467",
    "gateway": "mercadopago",
    "brandNumber": "101",
    "tipoOperacion": "recarga"
  }'
```

PayPal:
```bash
curl -X POST http://localhost:3000/run-flow \
  -H "Content-Type: application/json" \
  -d '{
    "folioCompra": "PAYPAL123",
    "dn": "9987460467",
    "gateway": "paypal",
    "purchaseDate": "2025-12-11",
    "tipoOperacion": "compra"
  }'
```

OpenPay:
```bash
curl -X POST http://localhost:3000/run-flow \
  -H "Content-Type: application/json" \
  -d '{
    "folioCompra": "OPENPAY123",
    "dn": "9987460467",
    "gateway": "openpay",
    "tipoOperacion": "recarga"
  }'
```

---

## 6. Timeouts configurados

- **SQL queries**: 650,000 ms (~ 10.83 minutos)
- **API procesanotificacionmercadopago**: 15,000 ms
- **API paypalwebhook**: 15,000 ms
- **API webhookopenpay**: 15,000 ms
- **API consultaConsumo**: 15,000 ms

---

## 7. Validaciones internas

**Tablas de negocio:**
- Si `tipoOperacion = 'recarga'`: valida en `diri_recarga` (columna `estatus`).
- Si `tipoOperacion = 'compra'`: valida en `diri_preventa` (columna `status` o `estatus`).

**MongoDB (tbl_orders):**
- Búsqueda por regex en `_id` (contiene folioCompra).
- Validación de status en `['Entregado', 'PAID']`.

**Consumo (consultaConsumo API):**
- Requiere marca numérica y dn de 10 dígitos.
- Llamadas con `fase: 'ANTES_DE_REPROCESO'` y `fase: 'DESPUES_DE_REPROCESO'`.
- Las diferencias se calculan de forma recursiva (incluye arrays y objetos anidados).

---

## 8. Recomendaciones

- **No comitear credenciales**: Use `.env` local (agregue a `.gitignore`).
- **Validar permisos en UAT**: Confirme que la cuenta UAT tiene permisos SELECT/INSERT/UPDATE.
- **Monitorear logs**: El array `log` en la respuesta documenta cada paso; úselo para debugging.
- **Validar conectividad**: Asegúrese de que PROD, UAT, MongoDB y APIs internas sean accesibles.
- **Consulte los timeouts**: Si encuentra timeouts frecuentes, revise la conectividad de red y capacidad de bases de datos.

