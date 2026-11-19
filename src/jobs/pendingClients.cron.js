import cron from 'node-cron';
import { syncPendingClients } from './pendingClients.service.js';

export function startPendingClientsCron() {
    // Todo dia às 12:00:00 (horário de Brasília)
    cron.schedule(
        '00 0 12 * * *',
        async () => {
            try {
                await syncPendingClients();
            } catch (err) {
                console.error('[pending-clients] erro na sync:', err.message);
            }
        },
        { timezone: 'America/Sao_Paulo' }
    );
    console.log('[pending-clients] cron agendado: 12:00 diário');
}