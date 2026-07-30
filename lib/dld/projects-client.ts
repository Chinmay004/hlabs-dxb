import { DLD_CONSUMER_ID, DLD_GATEWAY } from "./client";

const PROJECTS_ENDPOINT = `${DLD_GATEWAY}/open-data/projects`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const PROJECT_DATE_TYPES = {
  1: "startDate",
  2: "endDate",
  3: "adoptionDate",
  4: "completionDate",
} as const;

export type ProjectDateType = keyof typeof PROJECT_DATE_TYPES;

export interface DldProject {
  RN: number;
  TOTAL: number;
  DEFAULT_SORT: string | null;
  PROJECT_NUMBER: number | string;
  PROJECT_EN: string | null;
  PROJECT_AR: string | null;
  DEVELOPER_NUMBER: number | string | null;
  DEVELOPER_EN: string | null;
  DEVELOPER_AR: string | null;
  START_DATE: string | null;
  END_DATE: string | null;
  ADOPTION_DATE: string | null;
  PRJ_TYPE_EN: string | null;
  PRJ_TYPE_AR: string | null;
  PROJECT_VALUE: number | string | null;
  ESCROW_ACCOUNT_NUMBER: number | string | null;
  PROJECT_STATUS: string | null;
  PERCENT_COMPLETED: number | string | null;
  INSPECTION_DATE: string | null;
  COMPLETION_DATE: string | null;
  DESCRIPTION_EN: string | null;
  DESCRIPTION_AR: string | null;
  AREA_EN: string | null;
  AREA_AR: string | null;
  ZONE_EN: string | null;
  ZONE_AR: string | null;
  CNT_LAND: number | null;
  CNT_BUILDING: number | null;
  CNT_VILLA: number | null;
  CNT_UNIT: number | null;
  CNT_TOTAL: number | null;
  MASTER_PROJECT_EN: string | null;
  MASTER_PROJECT_AR: string | null;
}

interface ProjectsEnvelope {
  timeStamp: string;
  responseCode: number;
  validationErrorsList: unknown[];
  response: {
    result: DldProject[] | null;
    additionalData: unknown;
  } | null;
}

export class ProjectGatewayStats {
  requests = 0;
  errors = 0;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function sourceYearDates(year: number) {
  return {
    from: `01/01/${year}`,
    to: `12/31/${year}`,
  };
}

export async function fetchProjectsByDateType(
  dateType: ProjectDateType,
  options: {
    year?: number;
    stats?: ProjectGatewayStats;
    retries?: number;
  } = {},
): Promise<DldProject[]> {
  const year = options.year ?? new Date().getUTCFullYear();
  const retries = options.retries ?? 3;
  const { from, to } = sourceYearDates(year);
  const payload = {
    P_FROM_DATE: from,
    P_TO_DATE: to,
    P_DATE_TYPE: String(dateType),
    P_PRJ_TYPE_ID: "",
    P_PRJ_STATUS: "",
    P_ZONE_ID: "",
    P_AREA_ID: "",
    // The official frontend uses -1 for its complete CSV export. It returns the
    // whole selected result set in one response, avoiding paging drift.
    P_TAKE: "-1",
    P_SKIP: "",
    P_SORT: "PROJECT_NUMBER_ASC",
  };

  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    if (options.stats) options.stats.requests += 1;
    try {
      const response = await fetch(PROJECTS_ENDPOINT, {
        method: "POST",
        headers: {
          Accept: "application/json, */*",
          "Content-Type": "application/json; charset=UTF-8",
          Origin: "https://dubailand.gov.ae",
          Referer: "https://dubailand.gov.ae/",
          AppUser: "",
          "consumer-id": DLD_CONSUMER_ID,
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(payload),
        cache: "no-store",
        signal: AbortSignal.timeout(120_000),
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `DLD projects date type ${dateType} returned ${response.status}: ${text.slice(0, 400)}`,
        );
      }

      const envelope = JSON.parse(text) as ProjectsEnvelope;
      if (
        envelope.responseCode !== 200 ||
        !envelope.response ||
        !Array.isArray(envelope.response.result)
      ) {
        throw new Error(
          `DLD projects date type ${dateType} returned an invalid envelope`,
        );
      }
      return envelope.response.result;
    } catch (error) {
      lastError = error;
      if (options.stats) options.stats.errors += 1;
      if (attempt < retries) await wait(750 * 2 ** (attempt - 1));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`DLD projects date type ${dateType} failed`);
}

export async function fetchCurrentProjectUnion(options: {
  year?: number;
  stats?: ProjectGatewayStats;
  onProgress?: (message: string) => void;
} = {}) {
  const year = options.year ?? new Date().getUTCFullYear();
  const union = new Map<
    string,
    { raw: DldProject; dateMatchTypes: ProjectDateType[] }
  >();
  const rowsByDateType: Record<string, number> = {};

  // Sequential requests are deliberate. The endpoint is slow and occasionally
  // times out under concurrent load; four reliable calls are cheaper than a
  // burst followed by retries.
  for (const dateType of [1, 2, 3, 4] as ProjectDateType[]) {
    options.onProgress?.(
      `Projects: fetching ${PROJECT_DATE_TYPES[dateType]} matches for ${year}...`,
    );
    const rows = await fetchProjectsByDateType(dateType, {
      year,
      stats: options.stats,
    });
    rowsByDateType[String(dateType)] = rows.length;

    for (const raw of rows) {
      const projectNumber = String(raw.PROJECT_NUMBER).trim();
      if (!projectNumber) continue;
      const existing = union.get(projectNumber);
      if (existing) {
        if (!existing.dateMatchTypes.includes(dateType)) {
          existing.dateMatchTypes.push(dateType);
        }
        existing.raw = raw;
      } else {
        union.set(projectNumber, { raw, dateMatchTypes: [dateType] });
      }
    }
  }

  return {
    rows: [...union.values()].map((row) => ({
      ...row,
      dateMatchTypes: row.dateMatchTypes.sort(),
    })),
    rowsByDateType,
    year,
  };
}
