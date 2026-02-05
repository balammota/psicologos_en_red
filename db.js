const { Pool } = require('pg');

const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'psicologos_en_red_db',
    password: 'Flugufelsarinn18', // <--- Cambia esto
    port: 5432,
});

// ESTA FUNCIÓN PROBARÁ LA CONEXIÓN AL INICIAR
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.log("❌ ERROR DE CONTRASEÑA O CONEXIÓN:");
        console.error(err.message);
    } else {
        console.log("✅ ¡CONEXIÓN EXITOSA! La contraseña es correcta.");
    }
});

module.exports = pool;