import { pool } from '../utils/index.js';

// Situação financeira de UM cliente do seu sistema (cad_client.id)
export async function pendenciaPorClientId(clientId, companyId) {
    const { rows } = await pool.query(
        `SELECT client_id, deve, total_vencido, qtd_boletos_vencidos,
                maior_atraso_dias, vencimento_mais_antigo, consultado_em
           FROM vw_cad_client_pendencia
          WHERE client_id = $1 AND company_id = $2`,
        [clientId, companyId]
    );
    return rows[0] ?? { deve: false };
}

// Direto por documento (CPF/CNPJ com ou sem máscara)
export async function pendenciaPorDocumento(doc) {
    const { rows } = await pool.query(
        `SELECT codigo_cliente, cliente, deve, total_vencido, qtd_boletos_vencidos,
                maior_atraso_dias, consultado_em
           FROM enum_pedding_account
          WHERE doc_norm = public.norm_doc($1)`,
        [doc]
    );
    return rows[0] ?? { deve: false };
}

// Lista de inadimplentes da empresa
export async function listarInadimplentes(companyId) {
    const { rows } = await pool.query(
        `SELECT * FROM vw_cad_client_pendencia
          WHERE company_id = $1 AND deve
          ORDER BY total_vencido DESC`,
        [companyId]
    );
    return rows;
}