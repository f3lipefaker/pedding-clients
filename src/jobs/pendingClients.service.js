import { pool } from '../utils/index.js';

const BASE_URL = process.env.ERP_HUB_URL;
const CLIENT_ID = process.env.ERP_HUB_CLIENT_ID;
const CLIENT_SECRET = process.env.ERP_HUB_CLIENT_SECRET;
const PAGE_SIZE = 100;
const PAGE_DELAY_MS = 1100; // respeita 60 req/min

let cachedToken = null;
let tokenExpiresAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getToken(force = false) {
    if (!force && cachedToken && Date.now() < tokenExpiresAt - 15_000) return cachedToken;

    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const res = await fetch(`${BASE_URL}/oauth/token`, {
        method: 'POST',
        headers: {
            Authorization: `Basic ${basic}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(`Falha ao emitir token: HTTP ${res.status}`);

    const json = await res.json();
    cachedToken = json.access_token;
    tokenExpiresAt = Date.now() + json.expires_in * 1000;
    return cachedToken;
}

async function fetchPage(page, retried = false) {
    const token = await getToken();
    const res = await fetch(
        `${BASE_URL}/v1/cadastros/clientes/titulos-vencidos?page=${page}&pageSize=${PAGE_SIZE}`,
        { headers: { Authorization: `Bearer ${token}` } }
    );

    if (res.status === 401 && !retried) {
        await getToken(true);
        return fetchPage(page, true);
    }
    if (res.status === 429) {
        const wait = Number(res.headers.get('Retry-After') || 60);
        await sleep(wait * 1000);
        return fetchPage(page, retried);
    }
    if (!res.ok) {
        throw new Error(`Consulta falhou na página ${page}: HTTP ${res.status} (X-Request-Id: ${res.headers.get('X-Request-Id')})`);
    }
    return res.json();
}

async function fetchAllClients() {
    const all = [];
    let page = 1;
    while (true) {
        const { data, meta } = await fetchPage(page);
        all.push(...data);
        if (!meta.hasNext) break;
        page++;
        await sleep(PAGE_DELAY_MS);
    }
    return all;
}

export async function syncPendingClients() {
    const startedAt = new Date();
    console.log(`[pending-clients] sync iniciada ${startedAt.toISOString()}`);

    // Só toca no banco depois de baixar TUDO: falha parcial não marca ninguém como "não deve".
    const rows = await fetchAllClients();

    const db = await pool.connect();
    try {
        await db.query('BEGIN');

        for (const r of rows) {
            await db.query(
                `INSERT INTO enum_pedding_account (
                    codigo_cliente, cliente, cpf_cnpj, telefone_1, telefone_2, email, cidade, uf,
                    deve, qtd_boletos_vencidos, total_vencido, vencimento_mais_antigo, maior_atraso_dias,
                    ultimo_titulo, ultimo_nosso_numero, ultima_emissao, ultimo_vencimento,
                    ultimo_valor_original, ultimo_saldo_aberto, atraso_ultimo_boleto,
                    ultima_filial, ultimo_portador, ultima_carteira, consultado_em, atualizado_em
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, TRUE,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23, now())
                ON CONFLICT (codigo_cliente) DO UPDATE SET
                    cliente=EXCLUDED.cliente, cpf_cnpj=EXCLUDED.cpf_cnpj,
                    telefone_1=EXCLUDED.telefone_1, telefone_2=EXCLUDED.telefone_2,
                    email=EXCLUDED.email, cidade=EXCLUDED.cidade, uf=EXCLUDED.uf,
                    deve=TRUE,
                    qtd_boletos_vencidos=EXCLUDED.qtd_boletos_vencidos,
                    total_vencido=EXCLUDED.total_vencido,
                    vencimento_mais_antigo=EXCLUDED.vencimento_mais_antigo,
                    maior_atraso_dias=EXCLUDED.maior_atraso_dias,
                    ultimo_titulo=EXCLUDED.ultimo_titulo,
                    ultimo_nosso_numero=EXCLUDED.ultimo_nosso_numero,
                    ultima_emissao=EXCLUDED.ultima_emissao,
                    ultimo_vencimento=EXCLUDED.ultimo_vencimento,
                    ultimo_valor_original=EXCLUDED.ultimo_valor_original,
                    ultimo_saldo_aberto=EXCLUDED.ultimo_saldo_aberto,
                    atraso_ultimo_boleto=EXCLUDED.atraso_ultimo_boleto,
                    ultima_filial=EXCLUDED.ultima_filial,
                    ultimo_portador=EXCLUDED.ultimo_portador,
                    ultima_carteira=EXCLUDED.ultima_carteira,
                    consultado_em=EXCLUDED.consultado_em,
                    atualizado_em=now()`,
                [
                    r.CODIGO_CLIENTE, r.CLIENTE, r.CPF_CNPJ, r.TELEFONE_1 ?? null, r.TELEFONE_2 ?? null,
                    r.EMAIL ?? null, r.CIDADE ?? null, r.UF ?? null,
                    r.QTD_BOLETOS_VENCIDOS, r.TOTAL_VENCIDO, r.VENCIMENTO_MAIS_ANTIGO, r.MAIOR_ATRASO_DIAS,
                    r.ULTIMO_TITULO ?? null, r.ULTIMO_NOSSO_NUMERO ?? null, r.ULTIMA_EMISSAO ?? null,
                    r.ULTIMO_VENCIMENTO ?? null, r.ULTIMO_VALOR_ORIGINAL ?? null, r.ULTIMO_SALDO_ABERTO ?? null,
                    r.ATRASO_ULTIMO_BOLETO ?? null, r.ULTIMA_FILIAL ?? null, r.ULTIMO_PORTADOR ?? null,
                    r.ULTIMA_CARTEIRA ?? null, startedAt,
                ]
            );

            await db.query(
                `INSERT INTO enum_pedding_account_historico
                    (codigo_cliente, total_vencido, qtd_boletos, maior_atraso_dias, consultado_em)
                 VALUES ($1,$2,$3,$4,$5)`,
                [r.CODIGO_CLIENTE, r.TOTAL_VENCIDO, r.QTD_BOLETOS_VENCIDOS, r.MAIOR_ATRASO_DIAS, startedAt]
            );
        }

        // Quem não apareceu nesta consulta quitou (ou saiu do recorte): não deve mais.
        const { rowCount } = await db.query(
            `UPDATE enum_pedding_account
                SET deve = FALSE, qtd_boletos_vencidos = 0, total_vencido = 0,
                    consultado_em = $1, atualizado_em = now()
              WHERE consultado_em < $1 AND deve = TRUE`,
            [startedAt]
        );

        await db.query('COMMIT');
        console.log(`[pending-clients] ok: ${rows.length} devendo, ${rowCount} regularizados`);
        return { devendo: rows.length, regularizados: rowCount };
    } catch (err) {
        await db.query('ROLLBACK');
        throw err;
    } finally {
        db.release();
    }
}

// Consulta usada pelo resto do sistema
export async function clienteDeve(codigoCliente) {
    const { rows } = await pool.query(
        'SELECT deve, total_vencido, maior_atraso_dias, consultado_em FROM enum_pedding_account WHERE codigo_cliente = $1',
        [codigoCliente]
    );
    return rows[0] ?? { deve: false };
}