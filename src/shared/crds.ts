// Custom resources: one navigation entry per CRD, and a table whose columns are the CRD's additionalPrinterColumns.
// Pure, so the panel, the service and the tests agree.
import { gitopsFamily, gitopsView, GITOPS_KINDS } from './gitops.ts';
import { printerValue } from './jsonpath.ts';
import { NAV, timeOf, viewHelpers, type Column, type KindView, type NavSection, type StatusInfo, type Tone } from './kinds.ts';
import type { Obj } from './types.ts';

const { col, NAME, NAMESPACE, AGE, st, kv, text, arr } = viewHelpers;

export interface PrinterColumn {
  name: string;
  /** string, integer, number, boolean or date */
  type: string;
  jsonPath: string;
  description: string;
  priority: number;
}

/** What the panel needs to know about one CRD. The service builds it from the CRD and the cluster's discovery. */
export interface CrdEntry {
  group: string;
  kind: string;
  plural: string;
  singular: string;
  shortNames: string[];
  scope: 'Namespaced' | 'Cluster';
  /** The version the panel lists, the one the cluster's discovery serves for this group. */
  version: string;
  versions: string[];
  columns: PrinterColumn[];
  /** The schema has status.conditions, so a Status column can be drawn. */
  conditions: boolean;
}

export const CR_PREFIX = 'cr:';
export const isCrKind = (id: string): boolean => id.startsWith(CR_PREFIX);
/** The navigation id of a custom resource list. */
export const crId = (entry: Pick<CrdEntry, 'plural' | 'group'>): string => `${CR_PREFIX}${entry.plural}.${entry.group}`;
/** What the service's `kind` parameter takes for it: `plural.group`. */
export const crWatchKind = (id: string): string => id.slice(CR_PREFIX.length);

/** `ExternalSecrets` and `SecurityGroupPolicies`: the Kind in the plural form the CRD declares. */
export const crTitle = (entry: Pick<CrdEntry, 'kind' | 'plural'>): string => {
  const { kind, plural } = entry;
  const lower = kind.toLowerCase();
  const forms = [`${kind}s`, `${kind}es`, `${kind.slice(0, -1)}ies`, kind];
  const exact = forms.find((form) => form.toLowerCase() === plural);
  if (exact) return exact;
  if (plural.startsWith(lower)) return kind + plural.slice(lower.length);
  return plural.charAt(0).toUpperCase() + plural.slice(1);
};

// ----- Status from conditions

const READINESS = ['Ready', 'Available', 'Healthy', 'Synced', 'Succeeded', 'Complete', 'Established'];

/** A status for any object that follows the conditions convention, or null when it has none of the usual ones. */
export const conditionStatus = (object: Obj): StatusInfo | null => {
  const conditions = arr(object.status?.conditions);
  if (conditions.length === 0) return null;
  const failed = conditions.find((c) => /^(Failed|Stalled|Degraded)$/.test(text(c.type)) && c.status === 'True');
  if (failed) return st(text(failed.type), 'error');
  const found = READINESS.map((type) => conditions.find((c) => c.type === type)).find((c): c is Obj => Boolean(c));
  if (!found) return null;
  const type = text(found.type);
  if (found.status === 'True') return st(type, 'success');
  if (found.status === 'False') return st(type === 'Ready' ? 'Not ready' : `Not ${type.toLowerCase()}`, 'error');
  return st('Unknown', 'warning');
};

// ----- The table

const MAX_PRINTER_COLUMNS = 8;

const isAgeColumn = (column: PrinterColumn): boolean => /^\.?metadata\.creationTimestamp$/.test(column.jsonPath.replace(/^\{|\}$/g, '').trim());
const isNameColumn = (column: PrinterColumn): boolean => /^\.?metadata\.name$/.test(column.jsonPath.replace(/^\{|\}$/g, '').trim());

const STATE_COLUMN = /^(ready|status|synced|health|healthy|available|state|phase)$/i;
const GOOD = /^(true|ready|healthy|synced|running|active|available|bound|complete|completed|succeeded|deployed|valid|established|ok)$/i;
const BAD = /^(false|failed|failure|error|degraded|unhealthy|invalid|lost|notready|not ready|crashloopbackoff|outofsync)$/i;
const WAIT = /^(pending|progressing|unknown|creating|updating|terminating|syncing|reconciling)$/i;

/** A dot for the value of a state column (Ready, Status, Phase), when the value is one of the usual words. */
export const stateTone = (value: string): Tone | null => (GOOD.test(value) ? 'success' : BAD.test(value) ? 'error' : WAIT.test(value) ? 'warning' : null);

const printerColumn = (column: PrinterColumn, index: number): Column => {
  const get = (object: Obj): string | number | null => {
    const value = printerValue(object, column.jsonPath);
    if (value === null) return null;
    if (column.type === 'date') return typeof value === 'string' ? timeOf(value) : null;
    if ((column.type === 'integer' || column.type === 'number') && typeof value === 'number') return value;
    return String(value);
  };
  const hint = column.description || undefined;
  if (column.type === 'date') return col(`p${index}`, column.name, get, { cell: 'age', width: '72px', align: 'end', ...(hint ? { hint } : {}) });
  if (column.type === 'integer' || column.type === 'number') return col(`p${index}`, column.name, get, { width: '84px', align: 'end', ...(hint ? { hint } : {}) });
  if (column.type === 'string' && STATE_COLUMN.test(column.name)) {
    return col(`p${index}`, column.name, get, { cell: 'tone', tone: (o) => stateTone(String(get(o) ?? '')), width: 'minmax(90px, 1fr)', ...(hint ? { hint } : {}) });
  }
  return col(`p${index}`, column.name, get, { width: 'minmax(100px, 1.4fr)', ...(hint ? { hint } : {}) });
};

/** The columns a CRD declares, without Name and Age (the table always has those), the ordinary ones first and the wide ones after. */
export const printerColumns = (entry: Pick<CrdEntry, 'columns'>): PrinterColumn[] => {
  const usable = entry.columns.filter((column) => column.jsonPath && !isAgeColumn(column) && !isNameColumn(column));
  return [...usable.filter((c) => c.priority <= 0), ...usable.filter((c) => c.priority > 0)].slice(0, MAX_PRINTER_COLUMNS);
};

/** The table for one custom resource kind. GitOps kinds have their own curated views (see `viewForCrd`). */
export const crdView = (entry: CrdEntry): KindView => {
  const declared = printerColumns(entry);
  const columns: Column[] = [NAME, ...(entry.scope === 'Namespaced' ? [NAMESPACE] : []), ...declared.map(printerColumn)];
  const hasStatusColumn = declared.some((column) => STATE_COLUMN.test(column.name));
  const withStatus = entry.conditions && !hasStatusColumn;
  if (withStatus) columns.push(col('status', 'Status', (o) => conditionStatus(o)?.label ?? '', { cell: 'status', width: 'minmax(90px, 1fr)' }));
  columns.push(AGE);
  const rail = declared[0] ? 'p0' : withStatus ? 'status' : 'age';
  return {
    title: crTitle(entry),
    columns,
    sort: { column: 'name', dir: 'asc' },
    railColumn: rail,
    ...(entry.conditions ? { status: conditionStatus } : {}),
    details: (o) =>
      kv(...declared.map((column): [string, unknown] => [column.name, column.type === 'date' ? text(printerValue(o, column.jsonPath)) : printerValue(o, column.jsonPath)])),
  };
};

/** GitOps kinds get their curated view; every other custom resource gets one built from its printer columns. */
export const viewForCrd = (entry: CrdEntry): KindView => gitopsView(entry.group, entry.kind) ?? crdView(entry);

// ----- Navigation

const gitopsTitle = (entry: CrdEntry): string => gitopsView(entry.group, entry.kind)?.title ?? crTitle(entry);

/**
 * The navigation for a cluster: the fixed entries, then one section per API group of custom resources after Definitions,
 * and the Flux and Argo CD sections before Port forwarding. A GitOps kind appears there and not under its group.
 */
export const buildNav = (crds: readonly CrdEntry[]): NavSection[] => {
  const groups = new Map<string, CrdEntry[]>();
  const flux: CrdEntry[] = [];
  const argo: CrdEntry[] = [];
  for (const entry of crds) {
    const family = gitopsFamily(entry.group, entry.kind);
    if (family === 'flux') flux.push(entry);
    else if (family === 'argo') argo.push(entry);
    else groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry]);
  }
  const order = (list: CrdEntry[]): CrdEntry[] =>
    [...list].sort((a, b) => GITOPS_KINDS.findIndex((k) => k.kind === a.kind && k.group === a.group) - GITOPS_KINDS.findIndex((k) => k.kind === b.kind && k.group === b.group));
  const section = (id: string, title: string, list: CrdEntry[], titleOf: (entry: CrdEntry) => string): NavSection => ({
    id,
    title,
    heading: true,
    items: list.map((entry) => ({ kind: crId(entry), title: titleOf(entry) })),
  });

  const out: NavSection[] = [];
  for (const base of NAV) {
    if (base.id === 'forwards') {
      if (flux.length > 0) out.push(section('gitops-flux', 'GitOps: Flux', order(flux), gitopsTitle));
      if (argo.length > 0) out.push(section('gitops-argo', 'GitOps: Argo CD', order(argo), gitopsTitle));
    }
    out.push(base);
    if (base.id === 'crds') {
      for (const group of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
        const list = [...(groups.get(group) ?? [])].sort((a, b) => crTitle(a).localeCompare(crTitle(b)));
        out.push(section(`crd:${group}`, group, list, crTitle));
      }
    }
  }
  return out;
};

// ----- From the cluster's CRDs to entries

const conditionsInSchema = (version: Obj): boolean => Boolean(version.schema?.openAPIV3Schema?.properties?.status?.properties?.conditions);

/**
 * Builds the entries from the items of the CRD list. `versionFor` answers with the version the cluster's discovery serves
 * for a group and plural, so the columns match the list the panel will open. A CRD the cluster has not established is left out.
 */
export const entriesFromCrds = (items: readonly Obj[], versionFor: (group: string, plural: string) => string | undefined): CrdEntry[] => {
  const out: CrdEntry[] = [];
  for (const item of items) {
    const spec = item.spec as Obj | undefined;
    const names = spec?.names as Obj | undefined;
    if (!spec || !names || typeof spec.group !== 'string' || typeof names.kind !== 'string' || typeof names.plural !== 'string') continue;
    const established = arr(item.status?.conditions).find((c) => c.type === 'Established');
    if (established && established.status !== 'True') continue;
    const served = arr(spec.versions).filter((v) => v.served !== false);
    if (served.length === 0) continue;
    const wanted = versionFor(spec.group, names.plural);
    const chosen = served.find((v) => v.name === wanted) ?? served.find((v) => v.storage === true) ?? served[0]!;
    out.push({
      group: spec.group,
      kind: names.kind,
      plural: names.plural,
      singular: text(names.singular),
      shortNames: arr(names.shortNames).map(String),
      scope: spec.scope === 'Cluster' ? 'Cluster' : 'Namespaced',
      version: text(chosen.name),
      versions: served.map((v) => text(v.name)),
      columns: arr(chosen.additionalPrinterColumns).map((c) => ({
        name: text(c.name),
        type: text(c.type) || 'string',
        jsonPath: text(c.jsonPath ?? c.JSONPath),
        description: text(c.description),
        priority: Number.isFinite(Number(c.priority)) ? Number(c.priority) : 0,
      })),
      conditions: conditionsInSchema(chosen),
    });
  }
  return out;
};
