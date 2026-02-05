const pool = require('../db');

async function hasHadAppointment(psychologistUserId, patientUserId) {
    try {
        // Primero, obtener el psicologo_id de la tabla psicologos usando el usuario_id del psicólogo
        const psicologoResult = await pool.query('SELECT id FROM psicologos WHERE usuario_id = $1', [psychologistUserId]);

        if (psicologoResult.rows.length === 0) {
            console.warn(`Psychologist with user ID ${psychologistUserId} not found in psicologos table.`);
            return false;
        }

        const psicologoId = psicologoResult.rows[0].id;

        // Luego, verificar si existe al menos una cita entre ellos
        const citaResult = await pool.query(
            `SELECT 1 FROM citas
             WHERE psicologo_id = $1 AND paciente_id = $2
             LIMIT 1`,
            [psicologoId, patientUserId]
        );

        return citaResult.rows.length > 0;
    } catch (error) {
        console.error("Error checking for prior appointment:", error);
        return false;
    }
}

module.exports = { hasHadAppointment };