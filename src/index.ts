interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * GLEIF MCP — Global Legal Entity Identifier Foundation (free, no auth)
 *
 * The LEI is the ISO 17442 canonical identifier for any legal entity that's
 * party to a financial transaction (~2.5M issued). Pairs well with EDGAR,
 * OpenCorporates, and OpenSanctions for entity resolution and counterparty
 * due diligence.
 *
 * API: https://www.gleif.org/en/lei-data/gleif-api
 * Tools:
 * - search_lei:           fuzzy-match a legal entity name to an LEI
 * - get_lei:              full LEI record by LEI code (20-char alphanumeric)
 * - get_lei_relationships: parent / ultimate parent / children (Level 2 relationship records)
 */


const BASE_URL = 'https://api.gleif.org/api/v1';

const tools: McpToolExport['tools'] = [
  {
    name: 'search_lei',
    description:
      'Search the GLEIF LEI registry by legal entity name. Returns matched entities with their 20-character LEI, jurisdiction, status, and BIC/ISIN cross-references. Use the LEI to resolve canonical identity across SEC, OpenSanctions, and counterparty databases.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Legal entity name (full or partial)' },
        country: { type: 'string', description: 'Restrict to a jurisdiction (ISO 3166-1 alpha-2, e.g., "US", "DE")' },
        status: {
          type: 'string',
          description: 'ACTIVE | LAPSED | INACTIVE | PENDING | NULL',
          enum: ['ACTIVE', 'LAPSED', 'INACTIVE', 'PENDING', 'NULL'],
        },
        page_size: { type: 'number', description: '1-200 (default 25)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_lei',
    description:
      'Fetch the full Level 1 LEI record by 20-character LEI code. Returns legal name, registered address, headquarters address, entity category, legal form, registration authority, status, parent LEI (if any), and timestamps.',
    inputSchema: {
      type: 'object',
      properties: {
        lei: { type: 'string', description: '20-character LEI code' },
      },
      required: ['lei'],
    },
  },
  {
    name: 'get_lei_relationships',
    description:
      'Fetch Level 2 corporate hierarchy for an LEI: direct parent, ultimate parent, and direct children. Use to map ownership trees across multinational groups.',
    inputSchema: {
      type: 'object',
      properties: {
        lei: { type: 'string', description: '20-character LEI code' },
      },
      required: ['lei'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_lei':
      return searchLei(
        args.query as string,
        args.country as string | undefined,
        args.status as string | undefined,
        (args.page_size as number) ?? 25,
      );
    case 'get_lei':
      return getLei(args.lei as string);
    case 'get_lei_relationships':
      return getRelationships(args.lei as string);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function gleifFetch(path: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Accept: 'application/vnd.api+json' },
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 404) throw new Error(`GLEIF: not found (${body.slice(0, 120)})`);
    throw new Error(`GLEIF error: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

interface LeiRecord {
  id: string;
  attributes?: {
    lei?: string;
    entity?: {
      legalName?: { name?: string };
      otherNames?: { name?: string }[];
      legalAddress?: { addressLines?: string[]; city?: string; region?: string; country?: string; postalCode?: string };
      headquartersAddress?: { addressLines?: string[]; city?: string; region?: string; country?: string; postalCode?: string };
      jurisdiction?: string;
      category?: string;
      legalForm?: { id?: string; other?: string };
      status?: string;
    };
    registration?: {
      status?: string;
      initialRegistrationDate?: string;
      lastUpdateDate?: string;
      nextRenewalDate?: string;
      managingLou?: string;
    };
    bic?: string[];
    isins?: string[];
  };
  relationships?: {
    'direct-parent'?: { links?: { related?: string } };
    'ultimate-parent'?: { links?: { related?: string } };
    'direct-children'?: { links?: { related?: string } };
  };
}

function normalizeRecord(r: LeiRecord) {
  const a = r.attributes ?? {};
  const e = a.entity ?? {};
  return {
    lei: a.lei ?? r.id,
    legal_name: e.legalName?.name ?? null,
    other_names: (e.otherNames ?? []).map((n) => n.name).filter(Boolean),
    jurisdiction: e.jurisdiction ?? null,
    category: e.category ?? null,
    legal_form: e.legalForm?.id ?? e.legalForm?.other ?? null,
    entity_status: e.status ?? null,
    registration_status: a.registration?.status ?? null,
    initial_registration: a.registration?.initialRegistrationDate ?? null,
    last_update: a.registration?.lastUpdateDate ?? null,
    next_renewal: a.registration?.nextRenewalDate ?? null,
    managing_lou: a.registration?.managingLou ?? null,
    legal_address: fmtAddress(e.legalAddress),
    headquarters_address: fmtAddress(e.headquartersAddress),
    bic: a.bic ?? [],
    isins: a.isins ?? [],
    gleif_url: `https://search.gleif.org/#/record/${a.lei ?? r.id}`,
  };
}

function fmtAddress(a?: { addressLines?: string[]; city?: string; region?: string; country?: string; postalCode?: string }) {
  if (!a) return null;
  return {
    lines: a.addressLines ?? [],
    city: a.city ?? null,
    region: a.region ?? null,
    country: a.country ?? null,
    postal_code: a.postalCode ?? null,
  };
}

async function searchLei(query: string, country?: string, status?: string, pageSize = 25) {
  const params = new URLSearchParams({
    'filter[entity.legalName]': query,
    'page[size]': String(Math.min(200, Math.max(1, pageSize))),
  });
  if (country) params.set('filter[entity.legalAddress.country]', country);
  if (status) params.set('filter[entity.status]', status);

  const data = (await gleifFetch(`/lei-records?${params}`)) as {
    data?: LeiRecord[];
    meta?: { pagination?: { total?: number } };
  };

  return {
    total: data.meta?.pagination?.total ?? 0,
    results: (data.data ?? []).map(normalizeRecord),
  };
}

async function getLei(lei: string) {
  const data = (await gleifFetch(`/lei-records/${encodeURIComponent(lei)}`)) as { data?: LeiRecord };
  if (!data.data) throw new Error(`GLEIF: no record for LEI ${lei}`);
  return normalizeRecord(data.data);
}

async function getRelationships(lei: string) {
  // GLEIF exposes related-records endpoints under /lei-records/{lei}/{relationship}
  const [direct, ultimate, children] = await Promise.all([
    gleifFetch(`/lei-records/${encodeURIComponent(lei)}/direct-parent`).catch(() => null),
    gleifFetch(`/lei-records/${encodeURIComponent(lei)}/ultimate-parent`).catch(() => null),
    gleifFetch(`/lei-records/${encodeURIComponent(lei)}/direct-children?page[size]=200`).catch(() => null),
  ]);

  const normalizeOne = (resp: unknown) => {
    if (!resp) return null;
    const r = (resp as { data?: LeiRecord }).data;
    return r ? normalizeRecord(r) : null;
  };
  const normalizeMany = (resp: unknown) => {
    if (!resp) return [];
    const arr = (resp as { data?: LeiRecord[] }).data ?? [];
    return arr.map(normalizeRecord);
  };

  return {
    lei,
    direct_parent: normalizeOne(direct),
    ultimate_parent: normalizeOne(ultimate),
    direct_children: normalizeMany(children),
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
