# Simulador de Pagos – Consola Web de Apoyo a QA
By: Villegas Olvera Edgar|QA Sr

Aplicación web sencilla (Node.js + Express + HTML/JS) para apoyar pruebas de pagos consultando:

1. La pasarela de pago (actualmente solo MercadoPago).
2. La base de datos de producción (PROD) para la tabla `diri_webhook_mercadopago`.
3. Opcionalmente (si hay permisos) el ambiente UAT para reflejar o verificar el registro.

El objetivo es evitar cambiar manualmente entre Postman y SQL para las consultas más repetitivas.

---

## 1. Alcance actual

A la fecha, la aplicación soporta el siguiente flujo para **MercadoPago**:

1. El usuario ingresa en el front:
   - Folio de compra (`folioCompra`, usado como `external_reference`).
   - Número de marca (`brandNumber`).
   - Pasarela de pago (select, hoy solo implementada: `mercadopago`).
   - Tipo de operación (`recarga` o `compra`).

2. El backend:
   - Valida parámetros de entrada (tipos, longitudes, valores permitidos).
   - Llama a MercadoPago (`GET /v1/payments/search`) filtrando por `external_reference`.
   - Obtiene el primer resultado y extrae el `id` de pago (`folioMercado`).
   - Consulta la tabla de PROD `diriprod.diri_webhook_mercadopago` con `folio_mercadopago = folioMercado`.
   - Devuelve al front:
     - `folioCompra`.
     - `folioMercado`.
     - Detalle del registro en PROD (`registroProd`).
     - Respuesta completa de MercadoPago (`api1Response`).
     - Un arreglo `log` con los pasos realizados, usado para mostrar un checklist y barra de progreso.

3. El front:
   - Muestra un resumen de estatus (éxito, advertencia o error).
   - Muestra una barra de progreso del flujo.
   - Muestra un checklist de pasos usando los mensajes de `log`.
   - Permite ver/ocultar el detalle técnico completo en formato JSON.

### Sobre UAT

En el código existe lógica para:

- Verificar si existe ya un registro en UAT (`diriuat.diri_webhook_mercadopago`).
- Insertar en UAT una copia del registro de PROD.
- Verificar nuevamente el registro en UAT.

Sin embargo, actualmente el usuario de BD configurado para UAT (`dev_user`) **no tiene permisos de SELECT/DELETE/INSERT** sobre la tabla, por lo que estos pasos fallan.

En la práctica, por ahora se considera que:

- El flujo seguro y estable es: **MercadoPago → PROD**.
- Toda operación sobre UAT requiere:
  - Ajustes de permisos a nivel BD, o
  - Un cambio de diseño (por ejemplo, usar un servicio interno de back que encapsule esos accesos).

Quien tome el proyecto debe revisar la sección [4. Configuración de BD y permisos](#4-configuración-de-bd-y-permisos) antes de asumir que UAT está disponible.

---

## 2. Arquitectura y componentes

Estructura básica del proyecto:

- `server.js`  
  Servidor Express. Expone:
  - Archivos estáticos desde `public/`.
  - Endpoint principal `POST /run-flow` que orquesta el flujo.

- `public/index.html`  
  Interfaz web:
  - Formulario de entrada (folio, marca, pasarela, tipo de operación).
  - Resumen de estado.
  - Barra de progreso.
  - Checklist de pasos (a partir de `log`).
  - Panel colapsable con JSON completo de la ejecución.

- `db.js` (no se incluye aquí su contenido)  
  Debe exportar:
  ```js
  const { prodPool, uatPool } = require("./db");
  Cada pool debe ser una instancia de mysql2/promise configurada hacia las BD de PROD y UAT respectivamente.

Tecnologías principales:
	- Node.js (se recomienda v18 o superior).
	- Express.
	- Axios (para llamadas HTTP a MercadoPago).
	- mysql2/promise (para acceso a MySQL/MariaDB).

⸻

## 3. Flujo detallado del endpoint /run-flow

Archivo: server.js

3.1. Entrada esperada

```json
{
  "folioCompra": "string obligatoria, <= 100 caracteres",
  "brandNumber": "string numérica opcional (1 a 6 dígitos)",
  "gateway": "mercadopago | paypal | openpay | stripe",
  "tipoOperacion": "recarga | compra"
}
```
Validaciones clave:
	- folioCompra: no vacío, tipo string, longitud razonable.
	- brandNumber: opcional, pero si existe, debe cumplir regex ^[0-9]{1,6}$.
	- gateway: se normaliza a minúsculas y debe estar en la lista [mercadopago, paypal, openpay, stripe].
	- tipoOperacion: se normaliza a minúsculas y debe estar en [recarga, compra].

Si alguna validación falla, responde con:
```json
{
  "status": "VALIDACION_ERROR",
  "mensaje": "texto explicativo"
}
```

