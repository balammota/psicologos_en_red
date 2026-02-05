const { Pool } = require('pg');

// En Railway/hosting: usar variable DATABASE_URL (la crea Railway al añadir Postgres).
// SSL necesario para Railway/Render/Heroku (rejectUnauthorized: false para certificados propios).
function getPoolConfig() {
    // Railway puede inyectar DATABASE_URL, DATABASE_PUBLIC_URL o DATABASE_PRIVATE_URL
    const url = process.env.DATABASE_URL
        || process.env.DATABASE_PUBLIC_URL
        || process.env.DATABASE_PRIVATE_URL
        || process.env.POSTGRES_URL;
    if (process.env.PORT) {
        console.log('[DB] DATABASE_URL presente:', !!url, '| Variables con DATA:', Object.keys(process.env).filter(k => k.includes('DATABASE') || k.includes('POSTGRES')).join(', ') || 'ninguna');
    }
    if (url) {
        const isLocal = /localhost|127\.0\.0\.1/.test(url);
        return {
            connectionString: url,
            ssl: isLocal ? false : { rejectUnauthorized: false },
        };
    }
    return {
        user: 'postgres',
        host: 'localhost',
        database: 'psicologos_en_red_db',
        password: 'Flugufelsarinn18',
        port: 5432,
    };
}

const pool = new Pool(getPoolConfig());

pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        if (!process.env.DATABASE_URL && process.env.PORT) {
            console.error('❌ DATABASE_URL no está definida. En Railway: Variables → añade DATABASE_URL desde tu servicio Postgres.');
        }
        console.error('❌ Postgres:', err.message);
    } else {
        console.log('✅ Postgres conectado.');
    }
});

module.exports = pool;
