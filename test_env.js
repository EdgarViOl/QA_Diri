require('dotenv').config({ path: './variables.env' });

console.log("Verificando carga de variables de entorno...");

const variablesToCheck = [
    "MP_SEARCH_URL",
    "MP_ACCESS_TOKEN",
    "INTERNAL_NOTIF_MP_URL",
    "INTERNAL_API_TOKEN",
    "INTERNAL_PAYPAL_WEBHOOK_URL",
    "INTERNAL_PAYPAL_TOKEN",
    "INTERNAL_STRIPE_WEBHOOK_URL",
    "INTERNAL_STRIPE_TOKEN",
    "INTERNAL_OPENPAY_WEBHOOK_URL",
    "INTERNAL_CONSUMO_URL",
    "MONGO_URI"
];

let allLoaded = true;

variablesToCheck.forEach(varName => {
    const value = process.env[varName];
    if (value) {
        // Mostrar solo los primeros caracteres para seguridad
        const maskedValue = value.length > 10 ? value.substring(0, 4) + "..." + value.substring(value.length - 4) : "****";
        console.log(`success${varName}: Cargada (${maskedValue})`);
    } else {
        console.error(`error ${varName}: NO ENCONTRADA`);
        allLoaded = false;
    }
});

if (allLoaded) {
    console.log("\n¡Éxito! Todas las variables se cargaron correctamente.");
} else {
    console.log("\nAlerta: Algunas variables faltan.");
}
