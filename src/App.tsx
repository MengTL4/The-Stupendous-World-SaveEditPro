import { type ReactNode, type UIEvent, useEffect, useMemo, useState } from "react";
import { decodeSaveText, encodeSaveText, type SaveTextParts } from "./codec";

type InventoryKind = "items" | "weapons" | "armors";
type CatalogKind = InventoryKind | "actors" | "skills";
type DbKind = CatalogKind;

interface DbEntry {
  id: number;
  name: string;
  description: string;
  itypeId: number | null;
  etypeId: number | null;
  atypeId: number | null;
  stypeId: number | null;
}

interface SaveState {
  value: unknown;
  parts: SaveTextParts;
  sourceName: string;
}

interface ParsedInventoryRow {
  id: number;
  name: string;
  description: string;
  quantity: number;
  category: number | null;
}

interface ParsedInventoryResult {
  rows: ParsedInventoryRow[];
  totalEntries: number;
  skippedUnknownId: number;
  skippedInvalidEntry: number;
}

interface ParsedActorRow {
  id: number;
  name: string;
}

interface ParsedActorResult {
  rows: ParsedActorRow[];
  totalEntries: number;
  skippedUnknownId: number;
  skippedInvalidEntry: number;
}

interface ParsedActorDataRow {
  index: number;
  actorId: number;
  name: string;
  hp: number;
  mp: number;
  tp: number;
  level: number;
  exp: number;
  skills: number[];
}

interface ParsedActorDataResult {
  rows: ParsedActorDataRow[];
  totalEntries: number;
  skippedUnknownActorId: number;
  skippedUnknownSkillId: number;
  skippedInvalidEntry: number;
}

interface DbState {
  items: DbEntry[];
  weapons: DbEntry[];
  armors: DbEntry[];
  actors: DbEntry[];
  skills: DbEntry[];
}

interface UndoEntry {
  label: string;
  value: unknown;
}

const UNDO_LIMIT = 30;
const CATALOG_RENDER_BATCH = 300;

const DB_FILE_CONFIG: Array<{ kind: DbKind; label: string; aliases: [string, string] }> = [
  { kind: "items", label: "Items.json", aliases: ["Items.json", "items.json"] },
  { kind: "weapons", label: "Weapons.json", aliases: ["Weapons.json", "weapons.json"] },
  { kind: "armors", label: "Armors.json", aliases: ["Armors.json", "armors.json"] },
  { kind: "actors", label: "Actors.json", aliases: ["Actors.json", "actors.json"] },
  { kind: "skills", label: "Skills.json", aliases: ["Skills.json", "skills.json"] },
];

const CATALOG_TABS: Array<{ kind: CatalogKind; label: string }> = [
  { kind: "items", label: "物品" },
  { kind: "weapons", label: "武器" },
  { kind: "armors", label: "护甲" },
  { kind: "actors", label: "角色" },
  { kind: "skills", label: "技能" },
];

const INVENTORY_PANELS: Array<{ kind: InventoryKind; title: string }> = [
  { kind: "items", title: "当前存档物品(_items)" },
  { kind: "weapons", title: "当前存档武器(_weapons)" },
  { kind: "armors", title: "当前存档护甲(_armors)" },
];

function cloneForUndo<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function toIntOrNull(value: unknown): number | null {
  const parsed = toFiniteNumber(value);
  if (parsed == null) {
    return null;
  }
  return Math.trunc(parsed);
}

function readDbArray(text: string): unknown[] {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("数据库文件必须是 JSON 数组。");
  }
  return parsed;
}

function parseDbEntries(raw: unknown[]): DbEntry[] {
  const out: DbEntry[] = [];
  for (const row of raw) {
    if (!isRecord(row)) {
      continue;
    }
    const id = toIntOrNull(row.id);
    if (id == null || id <= 0) {
      continue;
    }
    out.push({
      id,
      name: typeof row.name === "string" ? row.name : "",
      description: typeof row.description === "string" ? row.description : "",
      itypeId: toIntOrNull(row.itypeId),
      etypeId: toIntOrNull(row.etypeId),
      atypeId: toIntOrNull(row.atypeId),
      stypeId: toIntOrNull(row.stypeId),
    });
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}

function parseActorEntries(raw: unknown[]): DbEntry[] {
  const out: DbEntry[] = [];
  for (const row of raw) {
    if (!isRecord(row)) {
      continue;
    }
    const id = toIntOrNull(row.id);
    if (id == null || id <= 0) {
      continue;
    }
    out.push({
      id,
      name: typeof row.name === "string" ? row.name : "",
      description: typeof row.profile === "string" ? row.profile : "",
      itypeId: null,
      etypeId: null,
      atypeId: null,
      stypeId: null,
    });
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}

function parseDbByKind(kind: DbKind, text: string): DbEntry[] {
  const raw = readDbArray(text);
  return kind === "actors" ? parseActorEntries(raw) : parseDbEntries(raw);
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = parent[key];
  if (isRecord(current)) {
    return current;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function createDownload(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function stripExt(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) {
    return filename;
  }
  return filename.slice(0, dot);
}

function categoryLabel(kind: CatalogKind): string {
  if (kind === "actors") {
    return "-";
  }
  if (kind === "skills") {
    return "stypeId";
  }
  if (kind === "items") {
    return "itypeId";
  }
  if (kind === "weapons") {
    return "etypeId";
  }
  return "atypeId";
}

function entryCategory(entry: DbEntry, kind: CatalogKind): number | null {
  if (kind === "actors") {
    return null;
  }
  if (kind === "skills") {
    return entry.stypeId;
  }
  if (kind === "items") {
    return entry.itypeId;
  }
  if (kind === "weapons") {
    return entry.etypeId;
  }
  return entry.atypeId;
}

function containerKey(kind: InventoryKind): "_items" | "_weapons" | "_armors" {
  if (kind === "items") {
    return "_items";
  }
  if (kind === "weapons") {
    return "_weapons";
  }
  return "_armors";
}

function fuzzyMatchIndexes(text: string, query: string): number[] | null {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [];
  }

  const source = text.toLowerCase();
  const indexes: number[] = [];
  let qi = 0;

  for (let i = 0; i < source.length && qi < needle.length; i += 1) {
    if (source[i] === needle[qi]) {
      indexes.push(i);
      qi += 1;
    }
  }

  return qi === needle.length ? indexes : null;
}

function renderFuzzyName(text: string, query: string): ReactNode {
  const source = text || "(无名)";
  const indexes = fuzzyMatchIndexes(source, query);
  if (!query.trim() || !indexes || indexes.length === 0) {
    return source;
  }

  const set = new Set(indexes);
  return source.split("").map((char, index) =>
    set.has(index) ? (
      <mark key={`m-${index}`} className="hl">
        {char}
      </mark>
    ) : (
      <span key={`s-${index}`}>{char}</span>
    )
  );
}

function parseExistingInventory(
  saveState: SaveState | null,
  kind: InventoryKind,
  dbMap: Map<number, DbEntry>
): ParsedInventoryResult {
  if (!saveState || !isRecord(saveState.value)) {
    return { rows: [], totalEntries: 0, skippedUnknownId: 0, skippedInvalidEntry: 0 };
  }
  const partyRaw = saveState.value.party;
  if (!isRecord(partyRaw)) {
    return { rows: [], totalEntries: 0, skippedUnknownId: 0, skippedInvalidEntry: 0 };
  }

  const source = partyRaw[containerKey(kind)];
  if (!isRecord(source)) {
    return { rows: [], totalEntries: 0, skippedUnknownId: 0, skippedInvalidEntry: 0 };
  }

  const rows: ParsedInventoryRow[] = [];
  let skippedUnknownId = 0;
  let skippedInvalidEntry = 0;
  let totalEntries = 0;

  for (const [key, quantityRaw] of Object.entries(source)) {
    if (key.startsWith("@")) {
      continue;
    }
    totalEntries += 1;

    const id = toIntOrNull(key);
    const quantity = toFiniteNumber(quantityRaw);
    if (id == null || quantity == null) {
      skippedInvalidEntry += 1;
      continue;
    }

    const db = dbMap.get(id);
    if (!db) {
      skippedUnknownId += 1;
      continue;
    }

    rows.push({
      id,
      name: db.name,
      description: db.description,
      quantity,
      category: entryCategory(db, kind),
    });
  }

  rows.sort((a, b) => a.id - b.id);
  return { rows, totalEntries, skippedUnknownId, skippedInvalidEntry };
}

function parseExistingActors(
  saveState: SaveState | null,
  actorMap: Map<number, DbEntry>
): ParsedActorResult {
  if (!saveState || !isRecord(saveState.value)) {
    return { rows: [], totalEntries: 0, skippedUnknownId: 0, skippedInvalidEntry: 0 };
  }
  const partyRaw = saveState.value.party;
  if (!isRecord(partyRaw)) {
    return { rows: [], totalEntries: 0, skippedUnknownId: 0, skippedInvalidEntry: 0 };
  }

  const actorsRaw = partyRaw._actors;
  if (!isRecord(actorsRaw)) {
    return { rows: [], totalEntries: 0, skippedUnknownId: 0, skippedInvalidEntry: 0 };
  }
  const actorArray = actorsRaw["@a"];
  if (!Array.isArray(actorArray)) {
    return { rows: [], totalEntries: 0, skippedUnknownId: 0, skippedInvalidEntry: 0 };
  }

  const rows: ParsedActorRow[] = [];
  let skippedUnknownId = 0;
  let skippedInvalidEntry = 0;
  let totalEntries = 0;

  for (const idRaw of actorArray) {
    totalEntries += 1;
    const id = toIntOrNull(idRaw);
    if (id == null || id <= 0) {
      skippedInvalidEntry += 1;
      continue;
    }
    const actor = actorMap.get(id);
    if (!actor) {
      skippedUnknownId += 1;
      continue;
    }
    rows.push({ id, name: actor.name });
  }

  rows.sort((a, b) => a.id - b.id);
  return { rows, totalEntries, skippedUnknownId, skippedInvalidEntry };
}

function parseActorDataRows(
  saveState: SaveState | null,
  actorMap: Map<number, DbEntry>,
  skillMap: Map<number, DbEntry>
): ParsedActorDataResult {
  if (!saveState || !isRecord(saveState.value)) {
    return {
      rows: [],
      totalEntries: 0,
      skippedUnknownActorId: 0,
      skippedUnknownSkillId: 0,
      skippedInvalidEntry: 0,
    };
  }
  const actorsRoot = saveState.value.actors;
  if (!isRecord(actorsRoot)) {
    return {
      rows: [],
      totalEntries: 0,
      skippedUnknownActorId: 0,
      skippedUnknownSkillId: 0,
      skippedInvalidEntry: 0,
    };
  }
  const actorDataRoot = actorsRoot._data;
  if (!isRecord(actorDataRoot)) {
    return {
      rows: [],
      totalEntries: 0,
      skippedUnknownActorId: 0,
      skippedUnknownSkillId: 0,
      skippedInvalidEntry: 0,
    };
  }
  const actorArray = actorDataRoot["@a"];
  if (!Array.isArray(actorArray)) {
    return {
      rows: [],
      totalEntries: 0,
      skippedUnknownActorId: 0,
      skippedUnknownSkillId: 0,
      skippedInvalidEntry: 0,
    };
  }

  const rows: ParsedActorDataRow[] = [];
  let skippedInvalidEntry = 0;
  let skippedUnknownActorId = 0;
  let skippedUnknownSkillId = 0;
  let totalEntries = 0;

  for (let index = 0; index < actorArray.length; index += 1) {
    const row = actorArray[index];
    if (!isRecord(row)) {
      continue;
    }
    totalEntries += 1;

    const actorId = toIntOrNull(row._actorId);
    if (actorId == null || actorId <= 0) {
      skippedInvalidEntry += 1;
      continue;
    }
    const actorDef = actorMap.get(actorId);
    if (!actorDef) {
      skippedUnknownActorId += 1;
      continue;
    }

    const actorSkillsRaw = row._skills;
    const actorSkillsRoot = isRecord(actorSkillsRaw) ? actorSkillsRaw : null;
    const skillArrayRaw = actorSkillsRoot ? actorSkillsRoot["@a"] : null;

    const expPairs: Array<{ realmId: number; exp: number }> = [];
    const actorExpRaw = row._exp;
    if (isRecord(actorExpRaw)) {
      for (const [realmIdRaw, expRaw] of Object.entries(actorExpRaw)) {
        if (realmIdRaw.startsWith("@")) {
          continue;
        }
        const realmId = toIntOrNull(realmIdRaw);
        const expValue = toIntOrNull(expRaw);
        if (realmId == null || realmId <= 0 || expValue == null || expValue < 0) {
          continue;
        }
        expPairs.push({ realmId, exp: expValue });
      }
    }
    expPairs.sort((a, b) => a.realmId - b.realmId);
    const exp = expPairs.length > 0 ? expPairs[0].exp : 0;

    const skills: number[] = [];
    if (Array.isArray(skillArrayRaw)) {
      for (const skillRaw of skillArrayRaw) {
        const skillId = toIntOrNull(skillRaw);
        if (skillId != null && skillId > 0) {
          if (skillMap.size > 0 && !skillMap.has(skillId)) {
            skippedUnknownSkillId += 1;
            continue;
          }
          skills.push(skillId);
        }
      }
    }

    const actorName = (typeof row._name === "string" && row._name) || actorDef.name || `(未知角色 ${actorId})`;

    rows.push({
      index,
      actorId,
      name: actorName,
      hp: toIntOrNull(row._hp) ?? 0,
      mp: toIntOrNull(row._mp) ?? 0,
      tp: toIntOrNull(row._tp) ?? 0,
      level: Math.max(1, toIntOrNull(row._level) ?? 1),
      exp,
      skills,
    });
  }

  rows.sort((a, b) => a.actorId - b.actorId);
  return { rows, totalEntries, skippedUnknownActorId, skippedUnknownSkillId, skippedInvalidEntry };
}

function ensureActorDataArray(saveValue: Record<string, unknown>): unknown[] {
  const actorsRoot = ensureRecord(saveValue, "actors");
  const actorDataRoot = ensureRecord(actorsRoot, "_data");
  if (typeof actorDataRoot["@c"] !== "number") {
    actorDataRoot["@c"] = 0;
  }

  const arrayRaw = actorDataRoot["@a"];
  const actorArray = Array.isArray(arrayRaw) ? arrayRaw : [];
  actorDataRoot["@a"] = actorArray;
  return actorArray;
}

function ensureActorSkillArray(actorObj: Record<string, unknown>): unknown[] {
  const skillsRoot = ensureRecord(actorObj, "_skills");
  if (typeof skillsRoot["@c"] !== "number") {
    skillsRoot["@c"] = 0;
  }
  const raw = skillsRoot["@a"];
  const arr = Array.isArray(raw) ? raw : [];
  skillsRoot["@a"] = arr;
  return arr;
}

function ensureActorExpMap(actorObj: Record<string, unknown>): Record<string, unknown> {
  const expRoot = ensureRecord(actorObj, "_exp");
  if (typeof expRoot["@c"] !== "number") {
    expRoot["@c"] = 0;
  }
  return expRoot;
}

function App() {
  const [saveState, setSaveState] = useState<SaveState | null>(null);
  const [saveOutput, setSaveOutput] = useState("");
  const [db, setDb] = useState<DbState>({
    items: [],
    weapons: [],
    armors: [],
    actors: [],
    skills: [],
  });
  const [activeKind, setActiveKind] = useState<CatalogKind>("items");
  const [searchText, setSearchText] = useState("");
  const [qtyToAdd, setQtyToAdd] = useState(1);
  const [categoryFilter, setCategoryFilter] = useState<Record<CatalogKind, string>>({
    items: "all",
    weapons: "all",
    armors: "all",
    actors: "all",
    skills: "all",
  });
  const [preserveAffix, setPreserveAffix] = useState(true);
  const [status, setStatus] = useState(
    "就绪：先加载存档，再加载 Items/Weapons/Armors/Actors/Skills.json。"
  );
  const [error, setError] = useState<string | null>(null);
  const [selectedActorEditIndex, setSelectedActorEditIndex] = useState<number | null>(null);
  const [actorEditSearch, setActorEditSearch] = useState("");
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [catalogVisibleCount, setCatalogVisibleCount] = useState(CATALOG_RENDER_BATCH);

  const dbMap = useMemo(
    () => ({
      items: new Map(db.items.map((entry) => [entry.id, entry])),
      weapons: new Map(db.weapons.map((entry) => [entry.id, entry])),
      armors: new Map(db.armors.map((entry) => [entry.id, entry])),
      actors: new Map(db.actors.map((entry) => [entry.id, entry])),
      skills: new Map(db.skills.map((entry) => [entry.id, entry])),
    }),
    [db]
  );

  const currentCatalog = db[activeKind];
  const categoryValues = useMemo(() => {
    if (activeKind === "actors") {
      return [];
    }
    const set = new Set<number>();
    for (const entry of currentCatalog) {
      const val = entryCategory(entry, activeKind);
      if (val != null) {
        set.add(val);
      }
    }
    return [...set].sort((a, b) => a - b);
  }, [activeKind, currentCatalog]);

  const filteredCatalog = useMemo(() => {
    const keyword = searchText.trim();
    const keywordLower = keyword.toLowerCase();
    const selectedCategory = categoryFilter[activeKind];
    return currentCatalog.filter((entry) => {
      const matchedName = fuzzyMatchIndexes(entry.name, keyword) !== null;
      const matchedKeyword =
        keyword.length === 0 ||
        String(entry.id).includes(keywordLower) ||
        matchedName ||
        entry.description.toLowerCase().includes(keywordLower);
      if (!matchedKeyword) {
        return false;
      }
      if (selectedCategory === "all") {
        return true;
      }
      if (activeKind === "actors") {
        return true;
      }
      const cat = entryCategory(entry, activeKind);
      return String(cat ?? "") === selectedCategory;
    });
  }, [activeKind, categoryFilter, currentCatalog, searchText]);
  const currentCategory = categoryFilter[activeKind];

  const visibleCatalogRows = useMemo(
    () => filteredCatalog.slice(0, catalogVisibleCount),
    [catalogVisibleCount, filteredCatalog]
  );
  const hiddenCatalogCount = Math.max(0, filteredCatalog.length - visibleCatalogRows.length);

  const dbStatCards = useMemo(
    () =>
      DB_FILE_CONFIG.map((config) => ({
        ...config,
        count: db[config.kind].length,
      })),
    [db]
  );
  const loadedDbKinds = useMemo(
    () => dbStatCards.filter((card) => card.count > 0).length,
    [dbStatCards]
  );

  const existingInventoryByKind = useMemo(
    () => ({
      items: parseExistingInventory(saveState, "items", dbMap.items),
      weapons: parseExistingInventory(saveState, "weapons", dbMap.weapons),
      armors: parseExistingInventory(saveState, "armors", dbMap.armors),
    }),
    [dbMap.armors, dbMap.items, dbMap.weapons, saveState]
  );
  const existingActors = useMemo(
    () => parseExistingActors(saveState, dbMap.actors),
    [dbMap.actors, saveState]
  );
  const actorDataRows = useMemo(
    () => parseActorDataRows(saveState, dbMap.actors, dbMap.skills),
    [dbMap.actors, dbMap.skills, saveState]
  );
  const filteredActorEditRows = useMemo(() => {
    const keyword = actorEditSearch.trim().toLowerCase();
    if (!keyword) {
      return actorDataRows.rows;
    }
    return actorDataRows.rows.filter(
      (row) => String(row.actorId).includes(keyword) || row.name.toLowerCase().includes(keyword)
    );
  }, [actorDataRows.rows, actorEditSearch]);
  const selectedActorRow = useMemo(() => {
    const rows = filteredActorEditRows;
    if (rows.length === 0) {
      return null;
    }
    if (selectedActorEditIndex != null) {
      const found = rows.find((row) => row.index === selectedActorEditIndex);
      if (found) {
        return found;
      }
    }
    return rows[0];
  }, [filteredActorEditRows, selectedActorEditIndex]);

  const outputName = useMemo(() => {
    const source = saveState?.sourceName ?? "file1.rpgsave";
    return `${stripExt(source)}.inventory-edited.rpgsave`;
  }, [saveState?.sourceName]);

  useEffect(() => {
    setCatalogVisibleCount(CATALOG_RENDER_BATCH);
  }, [activeKind, currentCategory, searchText]);

  useEffect(() => {
    let cancelled = false;

    const loadAutoData = async (): Promise<void> => {
      const loaded: string[] = [];

      for (const config of DB_FILE_CONFIG) {
        let loadedText: string | null = null;

        for (const filename of config.aliases) {
          const candidates = [`/data/${filename}`, `./data/${filename}`];
          for (const path of candidates) {
            try {
              const response = await fetch(path, { cache: "no-store" });
              if (!response.ok) {
                continue;
              }
              loadedText = await response.text();
              break;
            } catch {
              // keep trying next candidate path
            }
          }
          if (loadedText != null) {
            break;
          }
        }

        if (loadedText == null) {
          continue;
        }

        try {
          const parsed = parseDbByKind(config.kind, loadedText);
          if (cancelled) {
            return;
          }
          setDb((prev) => ({ ...prev, [config.kind]: parsed }));
          loaded.push(`${config.kind}:${parsed.length}`);
        } catch {
          // ignore broken auto-load file, user can still load manually
        }
      }

      if (!cancelled && loaded.length > 0) {
        setStatus(`已自动加载 data 目录：${loaded.join("，")}`);
      }
    };

    void loadAutoData();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleLoadSave = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    try {
      const text = await file.text();
      const decoded = decodeSaveText(text);
      setSaveState({ value: decoded.value, parts: decoded.parts, sourceName: file.name });
      setSaveOutput("");
      setUndoStack([]);
      setError(null);
      setStatus(`已加载并解密存档：${file.name}`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`加载存档失败：${message}`);
      setStatus("加载存档失败。");
    } finally {
      event.target.value = "";
    }
  };

  const getEditableSaveValue = (): Record<string, unknown> | null => {
    if (!saveState) {
      setError("请先加载并解密存档。");
      return null;
    }
    if (!isRecord(saveState.value)) {
      setError("存档顶层结构不是对象，无法写入。");
      return null;
    }
    return saveState.value;
  };

  const createUndoSnapshot = (saveValue: Record<string, unknown>): unknown | null => {
    try {
      return cloneForUndo(saveValue);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`无法创建撤销快照：${message}`);
      return null;
    }
  };

  const commitSaveMutations = (nextStatus: string, undoSnapshot?: unknown, undoLabel?: string): void => {
    if (!saveState) {
      return;
    }
    if (undoSnapshot !== undefined && undoLabel) {
      setUndoStack((prev) => [{ label: undoLabel, value: undoSnapshot }, ...prev].slice(0, UNDO_LIMIT));
    }
    setSaveState({ ...saveState });
    setSaveOutput("");
    setError(null);
    setStatus(nextStatus);
  };

  const withEditableActor = (
    saveValue: Record<string, unknown>,
    actorIndex: number,
    callback: (actorRaw: Record<string, unknown>) => void
  ): boolean => {
    const actorArray = ensureActorDataArray(saveValue);
    const actorRaw = actorArray[actorIndex];
    if (!isRecord(actorRaw)) {
      setError(`actors._data.@a[${actorIndex}] 不是可编辑对象。`);
      return false;
    }
    callback(actorRaw);
    return true;
  };

  const batchAddFilteredToSave = (): void => {
    const saveValue = getEditableSaveValue();
    if (!saveValue) {
      return;
    }
    if (filteredCatalog.length === 0) {
      setError(null);
      setStatus("当前筛选结果为空，没有可批量添加的条目。");
      return;
    }

    if (activeKind === "skills" && !selectedActorRow) {
      setError("请先在“角色编辑”里选择一位角色后再批量添加技能。");
      return;
    }

    const undoSnapshot = createUndoSnapshot(saveValue);
    if (!undoSnapshot) {
      return;
    }

    const party = ensureRecord(saveValue, "party");
    if (activeKind === "actors") {
      const actorsContainer = ensureRecord(party, "_actors");
      const arrRaw = actorsContainer["@a"];
      const arr = Array.isArray(arrRaw) ? arrRaw : [];
      actorsContainer["@a"] = arr;
      if (typeof actorsContainer["@c"] !== "number") {
        actorsContainer["@c"] = 0;
      }

      let addedCount = 0;
      for (const entry of filteredCatalog) {
        const exists = arr.some((value) => toIntOrNull(value) === entry.id);
        if (exists) {
          continue;
        }
        arr.push(entry.id);
        addedCount += 1;
      }

      if (addedCount === 0) {
        setError(null);
        setStatus("筛选角色都已存在于 party._actors.@a，未发生变更。");
        return;
      }

      commitSaveMutations(
        `已批量添加 ${addedCount.toLocaleString()} 位角色到 party._actors.@a。`,
        undoSnapshot,
        `批量添加角色 ${addedCount.toLocaleString()} 项`
      );
      return;
    }

    if (activeKind === "skills" && selectedActorRow) {
      let addedCount = 0;
      const ok = withEditableActor(saveValue, selectedActorRow.index, (actorRaw) => {
        const skills = ensureActorSkillArray(actorRaw);
        for (const entry of filteredCatalog) {
          const exists = skills.some((value) => toIntOrNull(value) === entry.id);
          if (exists) {
            continue;
          }
          skills.push(entry.id);
          addedCount += 1;
        }
      });
      if (!ok) {
        return;
      }

      if (addedCount === 0) {
        setError(null);
        setStatus("筛选技能都已存在于当前角色，未发生变更。");
        return;
      }

      commitSaveMutations(
        `已批量添加 ${addedCount.toLocaleString()} 个技能到当前角色。`,
        undoSnapshot,
        `批量添加技能 ${addedCount.toLocaleString()} 项`
      );
      return;
    }

    let inventoryKind: InventoryKind;
    if (activeKind === "items" || activeKind === "weapons" || activeKind === "armors") {
      inventoryKind = activeKind;
    } else {
      return;
    }

    const quantity = Math.max(1, Math.trunc(qtyToAdd));
    const container = ensureRecord(party, containerKey(inventoryKind));
    let changedCount = 0;

    for (const entry of filteredCatalog) {
      const key = String(entry.id);
      const prev = toFiniteNumber(container[key]) ?? 0;
      container[key] = prev + quantity;
      changedCount += 1;
    }

    if (changedCount === 0) {
      setError(null);
      setStatus("当前筛选结果没有可更新条目。");
      return;
    }

    commitSaveMutations(
      `已批量添加 ${changedCount.toLocaleString()} 项，每项 +${quantity}。`,
      undoSnapshot,
      `批量添加${inventoryKind} ${changedCount.toLocaleString()} 项`
    );
  };

  const loadMoreCatalogRows = (): void => {
    setCatalogVisibleCount((prev) => Math.min(filteredCatalog.length, prev + CATALOG_RENDER_BATCH));
  };

  const handleCatalogScroll = (event: UIEvent<HTMLDivElement>): void => {
    if (hiddenCatalogCount <= 0) {
      return;
    }
    const target = event.currentTarget;
    if (target.scrollTop + target.clientHeight >= target.scrollHeight - 80) {
      loadMoreCatalogRows();
    }
  };

  const addToSave = (kind: CatalogKind, entry: DbEntry): void => {
    const saveValue = getEditableSaveValue();
    if (!saveValue) {
      return;
    }
    const party = ensureRecord(saveValue, "party");

    if (kind === "actors") {
      const actorsContainer = ensureRecord(party, "_actors");
      const arrRaw = actorsContainer["@a"];
      const arr = Array.isArray(arrRaw) ? arrRaw : [];
      actorsContainer["@a"] = arr;
      if (typeof actorsContainer["@c"] !== "number") {
        actorsContainer["@c"] = 0;
      }

      const exists = arr.some((value) => toIntOrNull(value) === entry.id);
      if (exists) {
        setError(null);
        setStatus(`角色 ${entry.name || "(无名)"} 已存在于 party._actors.@a，无需重复添加。`);
        return;
      }

      const undoSnapshot = createUndoSnapshot(saveValue);
      if (!undoSnapshot) {
        return;
      }

      arr.push(entry.id);
      commitSaveMutations(
        `已添加角色 ${entry.name || "(无名)"}（ID ${entry.id}）到 party._actors.@a。`,
        undoSnapshot,
        `添加角色 #${entry.id}`
      );
      return;
    }

    if (kind === "skills") {
      if (!selectedActorRow) {
        setError("请先在“角色编辑”里选择一位角色后再添加技能。");
        return;
      }
      addSkillByIdToActor(selectedActorRow.index, entry.id);
      return;
    }

    const quantity = Math.max(1, Math.trunc(qtyToAdd));
    const container = ensureRecord(party, containerKey(kind));
    const undoSnapshot = createUndoSnapshot(saveValue);
    if (!undoSnapshot) {
      return;
    }
    const key = String(entry.id);
    const prev = toFiniteNumber(container[key]) ?? 0;
    container[key] = prev + quantity;

    commitSaveMutations(
      `已添加 ${entry.name || "(无名)"} x${quantity} 到 ${containerKey(kind)}。`,
      undoSnapshot,
      `添加${kind} #${entry.id} x${quantity}`
    );
  };

  const updateInventoryQuantity = (
    kind: InventoryKind,
    id: number,
    nextQuantity: number
  ): void => {
    const saveValue = getEditableSaveValue();
    if (!saveValue) {
      return;
    }

    const party = ensureRecord(saveValue, "party");
    const container = ensureRecord(party, containerKey(kind));
    const key = String(id);
    const normalized = Math.max(0, Math.trunc(nextQuantity));
    const current = Math.max(0, Math.trunc(toFiniteNumber(container[key]) ?? 0));
    if (normalized === current) {
      setError(null);
      setStatus(`数量未变化：${dbMap[kind].get(id)?.name || `ID ${id}`} 仍为 ${current}。`);
      return;
    }

    const undoSnapshot = createUndoSnapshot(saveValue);
    if (!undoSnapshot) {
      return;
    }

    if (normalized <= 0) {
      delete container[key];
    } else {
      container[key] = normalized;
    }

    const label = dbMap[kind].get(id)?.name || `ID ${id}`;
    if (normalized <= 0) {
      commitSaveMutations(
        `已清零 ${label}（${containerKey(kind)}）。`,
        undoSnapshot,
        `清零${kind} #${id}`
      );
    } else {
      commitSaveMutations(
        `已设置 ${label} 数量为 ${normalized}（${containerKey(kind)}）。`,
        undoSnapshot,
        `设置${kind} #${id}=${normalized}`
      );
    }
  };

  const adjustInventoryQuantity = (kind: InventoryKind, id: number, delta: number): void => {
    const saveValue = getEditableSaveValue();
    if (!saveValue) {
      return;
    }
    const party = ensureRecord(saveValue, "party");
    const container = ensureRecord(party, containerKey(kind));
    const current = toFiniteNumber(container[String(id)]) ?? 0;
    const next = Math.max(0, current + delta);
    updateInventoryQuantity(kind, id, next);
  };

  const clearInventoryQuantity = (kind: InventoryKind, id: number): void => {
    updateInventoryQuantity(kind, id, 0);
  };

  const removeActorFromSave = (id: number): void => {
    const saveValue = getEditableSaveValue();
    if (!saveValue) {
      return;
    }
    const party = ensureRecord(saveValue, "party");
    const actorsContainer = ensureRecord(party, "_actors");
    const arrRaw = actorsContainer["@a"];
    if (!Array.isArray(arrRaw)) {
      setError("party._actors.@a 不是数组，无法移除角色。");
      return;
    }
    const next = arrRaw.filter((value) => toIntOrNull(value) !== id);
    if (next.length === arrRaw.length) {
      setError(null);
      setStatus(`角色 ID ${id} 不在 party._actors.@a 中，未发生变更。`);
      return;
    }

    const undoSnapshot = createUndoSnapshot(saveValue);
    if (!undoSnapshot) {
      return;
    }

    actorsContainer["@a"] = next;

    commitSaveMutations(`已从 party._actors.@a 移除角色 ID ${id}。`, undoSnapshot, `移除角色 #${id}`);
  };

  const updateActorNumericField = (
    actorIndex: number,
    field: "_hp" | "_mp" | "_tp" | "_level",
    nextValue: number
  ): void => {
    const saveValue = getEditableSaveValue();
    if (!saveValue) {
      return;
    }
    const undoSnapshot = createUndoSnapshot(saveValue);
    if (!undoSnapshot) {
      return;
    }

    withEditableActor(saveValue, actorIndex, (actorRaw) => {
      const normalized =
        field === "_level"
          ? Math.max(1, Math.trunc(nextValue || 1))
          : Math.max(0, Math.trunc(nextValue || 0));
      const current = Math.trunc(toFiniteNumber(actorRaw[field]) ?? 0);
      if (current === normalized) {
        setError(null);
        setStatus(`角色字段 ${field} 已是 ${normalized}，未发生变更。`);
        return;
      }
      actorRaw[field] = normalized;
      commitSaveMutations(
        `已更新角色字段 ${field} = ${normalized}。`,
        undoSnapshot,
        `更新角色索引${actorIndex}字段${field}`
      );
    });
  };

  const addSkillByIdToActor = (actorIndex: number, parsedSkillId: number): void => {
    const saveValue = getEditableSaveValue();
    if (!saveValue) {
      return;
    }
    if (!dbMap.skills.has(parsedSkillId)) {
      setError(`技能ID ${parsedSkillId} 不在 Skills.json 中，请检查后重试。`);
      return;
    }

    withEditableActor(saveValue, actorIndex, (actorRaw) => {
      const skillArray = ensureActorSkillArray(actorRaw);
      const exists = skillArray.some((value) => toIntOrNull(value) === parsedSkillId);
      if (exists) {
        setError(null);
        setStatus(`技能 ${parsedSkillId} 已存在，未重复添加。`);
        return;
      }

      const undoSnapshot = createUndoSnapshot(saveValue);
      if (!undoSnapshot) {
        return;
      }

      skillArray.push(parsedSkillId);
      commitSaveMutations(
        `已添加技能 ID ${parsedSkillId} 到角色索引 ${actorIndex}。`,
        undoSnapshot,
        `角色索引${actorIndex}添加技能#${parsedSkillId}`
      );
    });
  };

  const removeSkillFromActor = (actorIndex: number, skillId: number): void => {
    const saveValue = getEditableSaveValue();
    if (!saveValue) {
      return;
    }

    withEditableActor(saveValue, actorIndex, (actorRaw) => {
      const skillArray = ensureActorSkillArray(actorRaw);
      const next = skillArray.filter((value) => toIntOrNull(value) !== skillId);
      if (next.length === skillArray.length) {
        setError(null);
        setStatus(`技能 ID ${skillId} 不在角色索引 ${actorIndex} 的列表中。`);
        return;
      }

      const undoSnapshot = createUndoSnapshot(saveValue);
      if (!undoSnapshot) {
        return;
      }

      actorRaw._skills = {
        ...(isRecord(actorRaw._skills) ? actorRaw._skills : {}),
        "@a": next,
      };

      commitSaveMutations(
        `已从角色索引 ${actorIndex} 移除技能 ID ${skillId}。`,
        undoSnapshot,
        `角色索引${actorIndex}移除技能#${skillId}`
      );
    });
  };

  const setActorExpValue = (actorIndex: number, expValue: number): void => {
    const saveValue = getEditableSaveValue();
    if (!saveValue) {
      return;
    }

    withEditableActor(saveValue, actorIndex, (actorRaw) => {
      const actorId = toIntOrNull(actorRaw._actorId);
      if (actorId == null || actorId <= 0) {
        setError(`actors._data.@a[${actorIndex}] 缺少有效 _actorId。`);
        return;
      }

      const undoSnapshot = createUndoSnapshot(saveValue);
      if (!undoSnapshot) {
        return;
      }

      const expMap = ensureActorExpMap(actorRaw);
      let realmId: number | null = null;
      for (const key of Object.keys(expMap)) {
        if (key.startsWith("@")) {
          continue;
        }
        const parsed = toIntOrNull(key);
        if (parsed != null && parsed > 0) {
          realmId = parsed;
          break;
        }
      }
      if (realmId == null) {
        realmId = actorId;
      }

      const nonMetaKeys = Object.keys(expMap).filter((key) => !key.startsWith("@"));
      const normalizedExp = Math.max(0, Math.trunc(expValue));
      const currentExp = Math.max(0, Math.trunc(toFiniteNumber(expMap[String(realmId)]) ?? 0));
      if (currentExp === normalizedExp && nonMetaKeys.length === 1 && nonMetaKeys[0] === String(realmId)) {
        setError(null);
        setStatus(`角色索引 ${actorIndex} 的 _exp 已是 ${normalizedExp}，未发生变更。`);
        return;
      }

      for (const key of Object.keys(expMap)) {
        if (!key.startsWith("@")) {
          delete expMap[key];
        }
      }
      expMap[String(realmId)] = normalizedExp;

      commitSaveMutations(
        `已设置角色索引 ${actorIndex} 的 _exp = ${normalizedExp}。`,
        undoSnapshot,
        `更新角色索引${actorIndex}经验`
      );
    });
  };

  const buildSaveOutput = (): void => {
    if (!saveState) {
      setError("请先加载并解密存档。");
      return;
    }
    try {
      const next = encodeSaveText(saveState.value, preserveAffix ? saveState.parts : undefined);
      setSaveOutput(next);
      setError(null);
      setStatus(`已生成新存档文本：${next.length.toLocaleString()} 字符。`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`生成存档失败：${message}`);
      setStatus("生成存档失败。");
    }
  };

  const downloadSave = (): void => {
    if (!saveOutput.trim()) {
      setError("请先点击“生成存档输出”。");
      return;
    }
    createDownload(saveOutput, outputName);
    setError(null);
    setStatus(`已下载：${outputName}`);
  };

  return (
    <div className="app">
      <header className="header hero">
        <div>
          <h1>RPG 存档库存/角色修改器</h1>
          <p>
            一站式处理 <code>party._items</code>/<code>_weapons</code>/<code>_armors</code>、
            <code>party._actors.@a</code> 与 <code>actors._data.@a</code>，支持库存、角色属性、经验和技能编辑。
          </p>
        </div>
        <div className="hero-metrics">
          <div className="metric-card">
            <span>数据库加载进度</span>
            <strong>{loadedDbKinds}/5</strong>
          </div>
          <div className="metric-card">
            <span>当前输出文件</span>
            <strong>{outputName}</strong>
          </div>
        </div>
      </header>

      <div className="workspace">
      <section className="panel controls workspace-controls">
        <div className="row wrap loader-row">
          <label className="file-btn">
            加载存档(.rpgsave)
            <input type="file" accept=".rpgsave,.txt" onChange={handleLoadSave} />
          </label>
          <button className="primary" onClick={buildSaveOutput}>
            生成存档输出
          </button>
          <button className="primary" onClick={downloadSave}>
            下载存档
          </button>
        </div>

        <div className="stats-grid">
          {dbStatCards.map((card) => (
            <div key={`stat-${card.kind}`} className="badge">
              <span>{card.kind}</span>
              <strong>{card.count.toLocaleString()}</strong>
            </div>
          ))}
        </div>

        <div className="row wrap gap-lg action-row">
          <label className="toggle">
            <input
              type="checkbox"
              checked={preserveAffix}
              onChange={(event) => setPreserveAffix(event.target.checked)}
            />
            保留原存档前后缀
          </label>
          <div className="meta">已记录撤销快照 {undoStack.length} 步</div>
        </div>

        <div className="status" role="status" aria-live="polite">
          {status}
        </div>
        {error && <div className="error">{error}</div>}
      </section>

      <div className="workspace-column workspace-column-left">

      <section className="panel workspace-catalog">
        <div className="row wrap catalog-toolbar">
          <div className="tabs">
            {CATALOG_TABS.map((tab) => (
              <button
                key={`tab-${tab.kind}`}
                className={activeKind === tab.kind ? "active" : ""}
                onClick={() => setActiveKind(tab.kind)}
              >
                {tab.label}
                <span className="tab-count">{db[tab.kind].length.toLocaleString()}</span>
              </button>
            ))}
          </div>

          <div className="catalog-tools">
            <input
              className="search"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="搜索 id / 名称 / description"
            />
            <button onClick={() => setSearchText("")}>清空搜索</button>
          </div>

          {activeKind !== "actors" && (
            <label className="field">
              {categoryLabel(activeKind)}
              <select
                value={currentCategory}
                onChange={(event) =>
                  setCategoryFilter((prev) => ({ ...prev, [activeKind]: event.target.value }))
                }
              >
                <option value="all">全部</option>
                {categoryValues.map((value) => (
                  <option key={value} value={String(value)}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          )}

          {activeKind !== "actors" && activeKind !== "skills" && (
            <label className="field">
              添加数量
              <input
                type="number"
                min={1}
                value={qtyToAdd}
                onChange={(event) =>
                  setQtyToAdd(Math.max(1, Math.trunc(Number(event.target.value) || 1)))
                }
              />
            </label>
          )}

          <button className="batch-action" onClick={batchAddFilteredToSave} disabled={filteredCatalog.length === 0}>
            {activeKind === "skills"
              ? "批量加到当前角色"
              : activeKind === "actors"
                ? "批量添加筛选角色"
                : "批量添加筛选结果"}
          </button>

          <div className="meta">结果：{filteredCatalog.length.toLocaleString()} / {currentCatalog.length.toLocaleString()}，已渲染 {visibleCatalogRows.length.toLocaleString()}</div>
        </div>

        <div className="table-wrap" onScroll={handleCatalogScroll}>
          <table>
            <thead>
              <tr>
                <th>id</th>
                <th>名称</th>
                {activeKind !== "actors" && <th>description</th>}
                {activeKind !== "actors" && <th>{categoryLabel(activeKind)}</th>}
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleCatalogRows.map((entry) => (
                <tr key={`${activeKind}-${entry.id}`}>
                  <td>{entry.id}</td>
                  <td>{renderFuzzyName(entry.name, searchText)}</td>
                  {activeKind !== "actors" && <td className="desc">{entry.description || ""}</td>}
                  {activeKind !== "actors" && <td>{entryCategory(entry, activeKind) ?? "-"}</td>}
                  <td>
                    <button onClick={() => addToSave(activeKind, entry)}>
                      {activeKind === "skills" ? "加到当前角色" : "添加"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {hiddenCatalogCount > 0 && (
          <div className="table-footer">
            <span>还有 {hiddenCatalogCount.toLocaleString()} 条未渲染，滚动到底部会自动加载。</span>
            <button onClick={loadMoreCatalogRows}>
              再加载 {Math.min(CATALOG_RENDER_BATCH, hiddenCatalogCount).toLocaleString()} 条
            </button>
          </div>
        )}
      </section>

      </div>

      <div className="workspace-column workspace-column-right">

      <section className="panel split-4 workspace-inventory">
        {INVENTORY_PANELS.map((panel) => (
          <InventoryView
            key={`inv-${panel.kind}`}
            title={panel.title}
            kind={panel.kind}
            data={existingInventoryByKind[panel.kind]}
            onAdjust={adjustInventoryQuantity}
            onClear={clearInventoryQuantity}
          />
        ))}
        <ActorView
          title="当前存档角色(_actors.@a)"
          data={existingActors}
          onRemove={removeActorFromSave}
        />
      </section>

      <section className="panel workspace-actor">
        <h2>角色编辑（actors._data.@a）</h2>
        <div className="meta">
          可编辑角色 {actorDataRows.rows.length} / 解析条目 {actorDataRows.totalEntries}，跳过非法条目{" "}
          {actorDataRows.skippedInvalidEntry}，跳过未知角色ID {actorDataRows.skippedUnknownActorId}，
          跳过未知技能ID {actorDataRows.skippedUnknownSkillId}
        </div>
        <div className="actor-picker">
          <input
            className="actor-picker-search"
            value={actorEditSearch}
            onChange={(event) => setActorEditSearch(event.target.value)}
            placeholder="筛选角色（ID / 名称）"
          />
          <select
            className="actor-picker-select"
            value={selectedActorRow ? String(selectedActorRow.index) : ""}
            onChange={(event) => {
              const next = toIntOrNull(event.target.value);
              setSelectedActorEditIndex(next);
            }}
          >
            {filteredActorEditRows.map((row) => (
              <option key={`actor-select-${row.index}-${row.actorId}`} value={String(row.index)}>
                {`#${row.actorId} ${row.name || "(无名)"}`}
              </option>
            ))}
          </select>
          <div className="meta">
            共 {actorDataRows.rows.length} 位，筛选后 {filteredActorEditRows.length} 位；当前仅编辑 1 位角色
          </div>
        </div>
        {selectedActorRow ? (
          <div className="actor-data-grid">
            <ActorDataEditor
              key={`actor-data-${selectedActorRow.index}-${selectedActorRow.actorId}`}
              row={selectedActorRow}
              skillMap={dbMap.skills}
              onStatChange={(field, value) => updateActorNumericField(selectedActorRow.index, field, value)}
              onRemoveSkill={(skillId) => removeSkillFromActor(selectedActorRow.index, skillId)}
              onSetExp={(expValue) => setActorExpValue(selectedActorRow.index, expValue)}
            />
          </div>
        ) : (
          <div className="meta">当前存档没有可编辑角色数据。</div>
        )}
      </section>

      <section className="panel workspace-output">
        <h2>输出预览（可复制）</h2>
        <textarea
          value={saveOutput}
          onChange={(event) => setSaveOutput(event.target.value)}
          placeholder="点击“生成存档输出”后，这里会显示新的 .rpgsave 文本。"
        />
      </section>

      </div>
      </div>
    </div>
  );
}

function InventoryView({
  title,
  kind,
  data,
  onAdjust,
  onClear,
}: {
  title: string;
  kind: InventoryKind;
  data: ParsedInventoryResult;
  onAdjust: (kind: InventoryKind, id: number, delta: number) => void;
  onClear: (kind: InventoryKind, id: number) => void;
}) {
  return (
    <div className="inventory-box">
      <h3>{title}</h3>
      <div className="meta">
        有效条目 {data.rows.length} / 原始条目 {data.totalEntries}，跳过未知ID {data.skippedUnknownId}，
        跳过非法条目 {data.skippedInvalidEntry}
      </div>
      <div className="inventory-list">
        {data.rows.map((row) => (
          <div key={`${title}-${row.id}`} className="inventory-row">
            <span>#{row.id}</span>
            <span>{row.name || "(无名)"}</span>
            <span>x {row.quantity}</span>
            <div className="inventory-actions">
              <button onClick={() => onAdjust(kind, row.id, -10)}>-10</button>
              <button onClick={() => onAdjust(kind, row.id, -1)}>-1</button>
              <button onClick={() => onAdjust(kind, row.id, 1)}>+1</button>
              <button onClick={() => onAdjust(kind, row.id, 10)}>+10</button>
              <button onClick={() => onClear(kind, row.id)}>清零</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActorView({
  title,
  data,
  onRemove,
}: {
  title: string;
  data: ParsedActorResult;
  onRemove: (id: number) => void;
}) {
  return (
    <div className="inventory-box">
      <h3>{title}</h3>
      <div className="meta">
        有效条目 {data.rows.length} / 原始条目 {data.totalEntries}，跳过未知ID {data.skippedUnknownId}，
        跳过非法条目 {data.skippedInvalidEntry}
      </div>
      <div className="inventory-list">
        {data.rows.map((row) => (
          <div key={`${title}-${row.id}`} className="inventory-row actor-row">
            <span>#{row.id}</span>
            <span>{row.name || "(无名)"}</span>
            <span />
            <div className="inventory-actions">
              <button onClick={() => onRemove(row.id)}>移除</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActorDataEditor({
  row,
  skillMap,
  onStatChange,
  onRemoveSkill,
  onSetExp,
}: {
  row: ParsedActorDataRow;
  skillMap: Map<number, DbEntry>;
  onStatChange: (field: "_hp" | "_mp" | "_tp" | "_level", value: number) => void;
  onRemoveSkill: (skillId: number) => void;
  onSetExp: (expValue: number) => void;
}) {
  return (
    <div className="actor-card">
      <h3>
        #{row.actorId} {row.name || "(无名)"}
      </h3>
      <div className="actor-meta">数组索引: {row.index}</div>
      <div className="actor-stats-grid">
        <label>
          _hp
          <input
            type="number"
            min={0}
            value={row.hp}
            onChange={(event) => onStatChange("_hp", Number(event.target.value) || 0)}
          />
        </label>
        <label>
          _mp
          <input
            type="number"
            min={0}
            value={row.mp}
            onChange={(event) => onStatChange("_mp", Number(event.target.value) || 0)}
          />
        </label>
        <label>
          _tp
          <input
            type="number"
            min={0}
            value={row.tp}
            onChange={(event) => onStatChange("_tp", Number(event.target.value) || 0)}
          />
        </label>
        <label>
          _level
          <input
            type="number"
            min={1}
            value={row.level}
            onChange={(event) => onStatChange("_level", Number(event.target.value) || 1)}
          />
        </label>
        <label>
          _exp
          <input
            type="number"
            min={0}
            value={row.exp}
            onChange={(event) => onSetExp(Number(event.target.value) || 0)}
          />
        </label>
      </div>

      <div className="actor-skill-editor">
        <div className="actor-skill-title">技能列表（_skills.@a）</div>
        <div className="skill-list">
          {row.skills.map((skillId, skillIndex) => (
            <div key={`actor-${row.index}-skill-${skillId}-${skillIndex}`} className="skill-chip">
              <span>
                #{skillId} {skillMap.get(skillId)?.name || "(未知技能)"}
              </span>
              <button onClick={() => onRemoveSkill(skillId)}>删除</button>
            </div>
          ))}
          {row.skills.length === 0 && <div className="meta">当前无技能</div>}
        </div>
        <div className="meta">技能添加请在左侧切到“技能”标签后使用“加到当前角色”。</div>
      </div>
    </div>
  );
}

export default App;
