const fs = require("node:fs");
const sql = require("mssql");

const ARQINI_PATH = "C:\\siwin\\Siwin-Master\\arqini.ini";
const SIWIN_EXE_PATH = "C:\\siwin\\Siwin-Master\\Siwin\\Siwin.exe";

let activeSync = null;

const FORBIDDEN_SQL = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|EXEC(?:UTE)?|DBCC|BACKUP|RESTORE)\b/i;

function assertReadOnlyQuery(query) {
  const normalized = String(query || "").replace(/--.*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ").trim();
  if (!/^(SELECT|WITH)\b/i.test(normalized) || FORBIDDEN_SQL.test(normalized)) {
    throw new Error("Proteção do SIWIN: somente consultas de leitura são permitidas.");
  }
  return normalized;
}

function readQuery(request, query) {
  return request.query(assertReadOnlyQuery(query));
}

function readConnectionSettings() {
  if (!fs.existsSync(ARQINI_PATH) || !fs.existsSync(SIWIN_EXE_PATH)) {
    throw new Error("A instala\u00e7\u00e3o do SIWIN n\u00e3o foi localizada em C:\\siwin.");
  }

  const ini = fs.readFileSync(ARQINI_PATH, "latin1");
  const base = ini.match(/\[BASE\][\s\S]*?Atual\s*=\s*['\"]([^:'\"]+):([^'\"]+)['\"]/i);
  if (!base) throw new Error("Servidor e banco do SIWIN n\u00e3o foram reconhecidos.");

  const binary = fs.readFileSync(SIWIN_EXE_PATH).toString("latin1");
  const strings = binary.match(/[\x20-\x7e\xc0-\xff]{4,}/g)?.map((value) => value.trim()) || [];
  const userIndex = strings.findIndex((value) => value === `USER NAME=${base[2]}`);
  const passwordEntry = userIndex >= 0 ? strings[userIndex + 1] : "";
  const password = passwordEntry.match(/^password=(.+)$/i)?.[1];
  if (!password) throw new Error("A autentica\u00e7\u00e3o local do SIWIN n\u00e3o foi reconhecida.");

  return { server: base[1], database: base[2], user: base[2], password };
}

async function performSync(database) {
  const settings = readConnectionSettings();
  const pool = await new sql.ConnectionPool({
    server: settings.server,
    port: 1433,
    database: settings.database,
    user: settings.user,
    password: settings.password,
    connectionTimeout: 8000,
    requestTimeout: 30000,
    options: { encrypt: false, trustServerCertificate: true },
    pool: { max: 1, min: 0, idleTimeoutMillis: 5000 },
  }).connect();

  try {
    let scopedClients = 0;
    if (database.shouldRefreshSiwinScope()) {
      const scope = await readQuery(pool.request(), `
        SELECT DISTINCT cs.CAD
        FROM dbo.Cad_Clien_Sessao cs
        WHERE UPPER(RTRIM(cs.SESSAO)) LIKE 'M%'
      `);
      scopedClients = database.markSiwinStudioClients(scope.recordset);
    }
    const result = await readQuery(pool.request(), `
        SELECT
          p.PED,
          p.DATA AS PEDIDO_DATA,
          p.PREV_ENTREGA,
          p.SITUACAO,
          p.FOTOS_COBRADAS,
          c.CAD,
          CAST(1 AS int) AS ESTUDIO,
          RTRIM(cs.SESSAO) AS SESSAO,
          cs.SESSAO_PROFISSIONAL,
          cs.DATA_SESSAO,
          COALESCE(NULLIF(RTRIM(c.FANTASIA), ''), RTRIM(c.RAZAO)) AS NOME,
          RTRIM(c.E_MAIL) AS E_MAIL,
          RTRIM(COALESCE(NULLIF(c.FONE, ''), NULLIF(c.FONE_RES, ''), cc.FONE_RES)) AS FONE,
          RTRIM(COALESCE(NULLIF(c.CELULAR, ''), cc.CELULAR)) AS CELULAR,
          RTRIM(c.LOGRAD) AS LOGRADOURO,
          CONVERT(varchar(20), c.NUMERO) AS NUMERO,
          RTRIM(c.COMPLEMENTO) AS COMPLEMENTO,
          RTRIM(c.BAIRRO) AS BAIRRO,
          RTRIM(c.CIDADE) AS CIDADE,
          RTRIM(c.UF) AS UF,
          RTRIM(c.CEP) AS CEP,
          c.CADASTRO
        FROM dbo.Cad_Clien_Sessao cs
        INNER JOIN dbo.Cad c ON c.CAD = cs.CAD
        LEFT JOIN dbo.Cad_Clien cc ON cc.CAD = c.CAD
        OUTER APPLY (
          SELECT TOP 1 px.PED,px.DATA,px.PREV_ENTREGA,px.SITUACAO,
            (SELECT SUM(CASE WHEN pm.VL_TOTAL>0
              THEN ISNULL(pm.FOTOS_PB,0)+ISNULL(pm.FOTOS_CL,0) ELSE 0 END)
             FROM dbo.PED_MS pm WHERE pm.PED=px.PED) AS FOTOS_COBRADAS
          FROM dbo.PED px
          WHERE px.SESSAO=cs.SESSAO_PROFISSIONAL AND UPPER(RTRIM(px.PROF_SESSAO))='M'
          ORDER BY px.CADASTRO DESC,px.PED DESC
        ) p
        WHERE UPPER(RTRIM(cs.SESSAO)) LIKE 'M%'
          AND cs.DATA_SESSAO >= DATEADD(year,-2,CAST(GETDATE() AS date))
        ORDER BY cs.SESSAO_PROFISSIONAL
      `);
    const uniqueClients = [...new Map(result.recordset.map((row) => [Number(row.CAD), row])).values()];
    const clientResult = database.syncSiwinClients(uniqueClients);
    const orderResult = database.syncSiwinOrders(result.recordset);
    const pedIds = [...new Set(result.recordset.map((row) => Number(row.PED)).filter(Number.isInteger))];
    let itemResult = { syncedItems: 0 };
    let observationResult = { syncedObservations: 0 };
    if (pedIds.length) {
      const itemRequest = pool.request();
      const pedParameters = pedIds.map((ped, index) => {
        itemRequest.input(`ped${index}`, sql.Int, ped);
        return `@ped${index}`;
      });
      const itemRows = await readQuery(itemRequest, `
        SELECT p.PED,p.SESSAO,pm.PED_MS,RTRIM(COALESCE(ms.DESCR,'Produto sem cadastro')) AS PRODUTO,pm.QTDE,
          ISNULL(pm.FOTOS_PB,0)+ISNULL(pm.FOTOS_CL,0) AS FOTOS,
          pm.PU,pm.VL_DESC,pm.VL_TOTAL,pm.SITUACAO,
          RTRIM(tf.DESCR) AS TIPO_FOTO_DESCR,RTRIM(amp.DESCR) AS AMPLIACAO
        FROM dbo.PED p
        INNER JOIN dbo.PED_MS pm ON pm.PED=p.PED
        LEFT JOIN dbo.MS ms ON ms.MS=pm.MS
        LEFT JOIN dbo.TIPO_FOTO tf ON tf.TIPO_FOTO=pm.TIPO_FOTO
        LEFT JOIN dbo.MS amp ON amp.MS=pm.ID_MS_AMPLIACAO
        WHERE p.PED IN (${pedParameters.join(",")})
        ORDER BY p.PED,pm.PED_MS
      `);
      itemResult = database.replaceSiwinOrderItems(itemRows.recordset);
      const observationRequest = pool.request();
      const observationParameters = pedIds.map((ped, index) => {
        observationRequest.input(`obsPed${index}`, sql.Int, ped);
        return `@obsPed${index}`;
      });
      const observationRows = await readQuery(observationRequest, `
        SELECT po.PED_OBS,po.PED,RTRIM(po.USUARIO) AS USUARIO,po.CADASTRO,po.OBS
        FROM dbo.PED_OBS po
        WHERE po.PED IN (${observationParameters.join(",")})
        ORDER BY po.PED,po.CADASTRO,po.PED_OBS
      `);
      observationResult = database.replaceSiwinOrderObservations(observationRows.recordset, pedIds);
    }
    const sessions = database.getUnlinkedSessions();
    if (!sessions.length) return { ...clientResult, ...orderResult, ...itemResult, ...observationResult, scopedClients, linked: 0, unmatched: 0 };
    const request = pool.request();
    const parameters = sessions.map((session, index) => {
      const normalized = String(session).trim().toUpperCase().replace(/\s+/g, "");
      request.input(`sessao${index}`, sql.VarChar(30), normalized);
      return `@sessao${index}`;
    });
    const links = await readQuery(request, `
      SELECT cs.CAD, RTRIM(cs.SESSAO) AS SESSAO, cs.SESSAO_PROFISSIONAL
      FROM dbo.Cad_Clien_Sessao cs
      WHERE REPLACE(UPPER(RTRIM(cs.SESSAO)), ' ', '') IN (${parameters.join(",")})
      UNION ALL
      SELECT p.CAD, 'M' + CONVERT(varchar(20), p.SESSAO) AS SESSAO, p.SESSAO AS SESSAO_PROFISSIONAL
      FROM dbo.PED p
      WHERE 'M' + CONVERT(varchar(20), p.SESSAO) IN (${parameters.join(",")})
        AND p.CAD IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM dbo.Cad_Clien_Sessao cs
          WHERE REPLACE(UPPER(RTRIM(cs.SESSAO)), ' ', '') = 'M' + CONVERT(varchar(20), p.SESSAO)
        )
    `);
    return { ...clientResult, ...orderResult, ...itemResult, ...observationResult, scopedClients, ...database.linkSiwinSessions(links.recordset) };
  } finally {
    await pool.close();
  }
}

function syncClients(database) {
  if (!activeSync) activeSync = performSync(database).finally(() => { activeSync = null; });
  return activeSync;
}

function safeError(error) {
  const message = String(error?.message || "Falha ao sincronizar com o SIWIN.");
  return message.replace(/password\s*=\s*[^;\s]+/gi, "password=[protegida]");
}

module.exports = { syncClients, safeError };
