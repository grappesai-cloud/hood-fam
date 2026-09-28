import { toFunctionSelector, type Abi, type AbiFunction, type AbiParameter } from "viem";
import { hoodBlockZeroAbi, hoodFactoryAbi, hoodPortalAbi } from "@hood/sdk";

/// The launch functions on both machines, in every generation a deployed contract can be, all
/// derived from the SDK's ABI, which is generated from the v3 contracts.
///
/// Two structs grew in v3, both at the end so nothing that existed moved:
///   DirectConfig  gained `PenaltyConfig penalties`, then `uint32 auctionBlocks`
///   LaunchParams  gained `PenaltyConfig penalties`
/// and PenaltyConfig is, in this order and no other:
///   uint16 jeetTaxBps, uint32 jeetWindowSeconds, uint16 whaleTaxBps, uint24 whaleTickLimit,
///   uint16 kingBps, bool penaltiesToVault
///
/// v3 is the ABI as the SDK exports it (the two fields are appended only if a regeneration from
/// older artifacts ever left them out). v2 is derived by STRIPPING them; legacy is v2 without
/// `creatorFeeRecipient`. Deriving downwards is what keeps a regeneration from appending the
/// fields twice and quietly turning "v2" into v3 with a wrong selector on top.
///
/// Which shape a deployed contract takes is decided by its bytecode, not by this build: a function
/// selector is a PUSH4 constant in the dispatcher, so the code either contains the new selector or
/// it does not. That is the same check the direct form already runs for `creatorFeeRecipient`, and
/// it is what keeps a fresh web deploy launching against the live v2 contracts while the chain
/// upgrade is still pending. The selectors every generation must come out to are pinned in
/// EXPECTED_LAUNCH_SELECTORS and checked at load.

export interface PenaltyConfig {
  jeetTaxBps: number;
  jeetWindowSeconds: number;
  whaleTaxBps: number;
  whaleTickLimit: number;
  kingBps: number;
  penaltiesToVault: boolean;
}

/// Everything off. What a launch that touched none of the cards sends.
export const PENALTIES_OFF: PenaltyConfig = {
  jeetTaxBps: 0, jeetWindowSeconds: 0, whaleTaxBps: 0, whaleTickLimit: 0, kingBps: 0, penaltiesToVault: false,
};

/// The contracts' own ceilings, so the form refuses what the chain would refuse.
export const PENALTY_CAPS = {
  jeetTaxBps: 2_500,
  jeetWindowSeconds: 3_600,
  whaleTaxBps: 2_500,
  whaleTickLimit: 2_000,
  kingBps: 5_000,
  auctionBlocks: 300,
} as const;

const PENALTY_COMPONENTS: readonly AbiParameter[] = [
  { name: "jeetTaxBps", type: "uint16", internalType: "uint16" },
  { name: "jeetWindowSeconds", type: "uint32", internalType: "uint32" },
  { name: "whaleTaxBps", type: "uint16", internalType: "uint16" },
  { name: "whaleTickLimit", type: "uint24", internalType: "uint24" },
  { name: "kingBps", type: "uint16", internalType: "uint16" },
  { name: "penaltiesToVault", type: "bool", internalType: "bool" },
];

const PENALTIES_PARAM: AbiParameter = {
  name: "penalties", type: "tuple", internalType: "struct PenaltyConfig", components: PENALTY_COMPONENTS as AbiParameter[],
};
const AUCTION_PARAM: AbiParameter = { name: "auctionBlocks", type: "uint32", internalType: "uint32" };
/// The open buyers: the wallets, up to 32, that pay no opening tax in a launch's first seconds.
/// Appended to LaunchParams (factory v5) and to DirectConfig (portal v4).
const EXEMPT_PARAM: AbiParameter = { name: "exempt", type: "address[]", internalType: "address[]" };

type Tuple = AbiParameter & { components: readonly AbiParameter[] };
const isTuple = (p: AbiParameter | undefined): p is Tuple => Boolean(p && p.type === "tuple" && "components" in p);

function fn(abi: Abi, name: string): AbiFunction {
  const item = abi.find((i) => i.type === "function" && i.name === name);
  if (!item || item.type !== "function") throw new Error(`abi has no ${name}`);
  return item;
}

/// Rewrites one function's first tuple argument with `edit`, leaving everything else as it was.
function withFirstTuple(item: AbiFunction, edit: (t: Tuple) => Tuple): AbiFunction {
  const [first, ...rest] = item.inputs;
  if (!isTuple(first)) return item;
  return { ...item, inputs: [edit(first), ...rest] };
}

/// Appends the components that are not there yet, in the order given. A no-op on the v3 ABI.
const ensureComponents = (extra: readonly AbiParameter[]) => (t: Tuple): Tuple => {
  const have = new Set(t.components.map((c) => c.name));
  return { ...t, components: [...t.components, ...extra.filter((e) => !have.has(e.name))] };
};

/// Removes the components by name. This is how an older generation is derived from the v3 ABI.
const stripComponents = (names: readonly string[]) => (t: Tuple): Tuple =>
  ({ ...t, components: t.components.filter((c) => !names.includes(c.name ?? "")) });

/// Applies `edit` to the `config` tuple inside the portal's LaunchInput.
const editConfig = (edit: (t: Tuple) => Tuple) => (input: Tuple): Tuple => ({
  ...input,
  components: input.components.map((c) => c.name === "config" && isTuple(c) ? edit(c) : c),
});

// ---------------------------------------------------------------- the portal (direct launches)

const createLaunchAsExported = fn(hoodPortalAbi as unknown as Abi, "createLaunch");
const createTeamLaunchAsExported = fn(hoodPortalAbi as unknown as Abi, "createTeamLaunch");

const ALLOCATIONS_PARAM: AbiParameter = {
  name: "allocations", type: "tuple", internalType: "struct Allocations",
  components: [
    { name: "creatorBps", type: "uint16", internalType: "uint16" },
    { name: "buybackBps", type: "uint16", internalType: "uint16" },
    { name: "dividendsBps", type: "uint16", internalType: "uint16" },
    { name: "liquidityBps", type: "uint16", internalType: "uint16" },
  ],
};

/// DirectConfig up to v3, written out in full: v4 dropped the opening rules and the caps from the
/// middle of it, and no strip-and-append from the v4 shape can put fields back in the middle.
const DIRECT_CONFIG_V3: readonly AbiParameter[] = [
  { name: "buyTaxBps", type: "uint16", internalType: "uint16" },
  { name: "sellTaxBps", type: "uint16", internalType: "uint16" },
  { name: "snipeTaxBps", type: "uint16", internalType: "uint16" },
  { name: "snipeDecaySeconds", type: "uint32", internalType: "uint32" },
  { name: "restrictionBlocks", type: "uint32", internalType: "uint32" },
  { name: "maxHoldBps", type: "uint16", internalType: "uint16" },
  { name: "maxBuyBps", type: "uint16", internalType: "uint16" },
  { name: "tickStart", type: "int24", internalType: "int24" },
  { name: "tickBond", type: "int24", internalType: "int24" },
  ALLOCATIONS_PARAM,
  PENALTIES_PARAM,
  AUCTION_PARAM,
];

/// DirectConfig from v4: the two taxes, the two ticks, the allocations and the open buyers. The
/// opening tax is the one fixed schedule every launch runs, so nothing about it is a field.
const DIRECT_CONFIG_V4: readonly AbiParameter[] = [
  { name: "buyTaxBps", type: "uint16", internalType: "uint16" },
  { name: "sellTaxBps", type: "uint16", internalType: "uint16" },
  { name: "tickStart", type: "int24", internalType: "int24" },
  { name: "tickBond", type: "int24", internalType: "int24" },
  ALLOCATIONS_PARAM,
  EXEMPT_PARAM,
];

const withConfig = (components: readonly AbiParameter[]) => (t: Tuple): Tuple => ({ ...t, components: [...components] });

/// v4: the config as written above, on both the single launch and the team launch.
const createLaunchV4 = withFirstTuple(createLaunchAsExported, editConfig(withConfig(DIRECT_CONFIG_V4)));
const createTeamLaunchV4 = withFirstTuple(createTeamLaunchAsExported, editConfig(withConfig(DIRECT_CONFIG_V4)));

/// v3: `config` ends in `penalties` then `auctionBlocks`.
const createLaunchV3 = withFirstTuple(createLaunchAsExported, editConfig(withConfig(DIRECT_CONFIG_V3)));

/// v2: the same without the two fields.
const createLaunchV2 = withFirstTuple(createLaunchV3, editConfig(stripComponents(["penalties", "auctionBlocks"])));

/// legacy: the portal deployed before `creatorFeeRecipient` existed. Same derivation the direct
/// form used to do by itself.
const createLaunchLegacy = withFirstTuple(createLaunchV2, (input) => ({
  ...input,
  components: input.components.filter((c) => c.name !== "creatorFeeRecipient"),
}));

function replaceFn(abi: Abi, replacement: AbiFunction): Abi {
  return abi.map((i) => i.type === "function" && i.name === replacement.name ? replacement : i);
}

export type PortalGeneration = "legacy" | "v2" | "v3" | "v4";

export const portalAbis: Record<PortalGeneration, Abi> = {
  legacy: replaceFn(hoodPortalAbi as unknown as Abi, createLaunchLegacy),
  v2: replaceFn(hoodPortalAbi as unknown as Abi, createLaunchV2),
  v3: replaceFn(hoodPortalAbi as unknown as Abi, createLaunchV3),
  v4: replaceFn(replaceFn(hoodPortalAbi as unknown as Abi, createLaunchV4), createTeamLaunchV4),
};

export const createLaunchSelectors: Record<PortalGeneration, `0x${string}`> = {
  legacy: toFunctionSelector(createLaunchLegacy),
  v2: toFunctionSelector(createLaunchV2),
  v3: toFunctionSelector(createLaunchV3),
  v4: toFunctionSelector(createLaunchV4),
};

/// The portal's team launch (block zero on the direct machine) exists from v4 on and takes the v4
/// config. A portal whose code does not carry this selector cannot take team wallets.
export const createTeamLaunchSelector = toFunctionSelector(createTeamLaunchV4);
export const portalTakesTeam = (code: `0x${string}` | undefined) =>
  Boolean(code && code.toLowerCase().includes(createTeamLaunchSelector.slice(2).toLowerCase()));

/// v3 carried the creator penalties and the auction; v4 names the open buyers instead, and has
/// no opening rules or caps of its own.
export const portalTakesPenalties = (g: PortalGeneration | undefined) => g === "v3";
export const portalTakesExempt = (g: PortalGeneration | undefined) => g === "v4";

/// Which `createLaunch` the deployed portal answers to, read off its bytecode. `undefined` means
/// none of the four, which is a deployment problem the form should say out loud.
export function detectPortalGeneration(code: `0x${string}` | undefined): PortalGeneration | undefined {
  if (!code) return undefined;
  const hex = code.toLowerCase();
  for (const gen of ["v4", "v3", "v2", "legacy"] as const) {
    if (hex.includes(createLaunchSelectors[gen].slice(2).toLowerCase())) return gen;
  }
  return undefined;
}

// ---------------------------------------------------------------- the factory (curve launches)

const launchAsExported = fn(hoodFactoryAbi as unknown as Abi, "launch");
const launchCustomAsExported = fn(hoodFactoryAbi as unknown as Abi, "launchCustom");

/// The curve's opening rules, appended to LaunchParams after `penalties` in v4.
const GUARD_PARAM: AbiParameter = {
  name: "guard", type: "tuple", internalType: "struct CurveGuard",
  components: [
    { name: "snipeTaxBps", type: "uint16", internalType: "uint16" },
    { name: "snipeDecaySeconds", type: "uint32", internalType: "uint32" },
    { name: "restrictionBlocks", type: "uint32", internalType: "uint32" },
    { name: "maxBuyBps", type: "uint16", internalType: "uint16" },
  ],
};

/// v5: the open buyers. The penalties and the curve's opening rules are gone (every launch runs
/// the one fixed opening-tax schedule), and LaunchParams ends in `exempt`.
///
/// Each generation is derived from whatever the SDK exports by stripping the fields it does not
/// have and appending, in order, the ones it does, so a regeneration from any generation's
/// artifacts lands on the same four shapes.
const toV5 = (t: Tuple): Tuple => ensureComponents([EXEMPT_PARAM])(stripComponents(["penalties", "guard"])(t));
const toV4 = (t: Tuple): Tuple => ensureComponents([PENALTIES_PARAM, GUARD_PARAM])(stripComponents(["exempt"])(t));
const toV3 = (t: Tuple): Tuple => ensureComponents([PENALTIES_PARAM])(stripComponents(["guard", "exempt"])(t));
const toV2 = (t: Tuple): Tuple => stripComponents(["penalties", "guard", "exempt"])(t);

const launchV5 = withFirstTuple(launchAsExported, toV5);
const launchCustomV5 = withFirstTuple(launchCustomAsExported, toV5);
/// v4: LaunchParams ends in `penalties` then `guard`.
const launchV4 = withFirstTuple(launchAsExported, toV4);
const launchCustomV4 = withFirstTuple(launchCustomAsExported, toV4);
/// v3: LaunchParams ends in `penalties`. `launchCustom` takes the same params first.
const launchV3 = withFirstTuple(launchAsExported, toV3);
const launchCustomV3 = withFirstTuple(launchCustomAsExported, toV3);
/// v2: none of them.
const launchV2 = withFirstTuple(launchAsExported, toV2);
const launchCustomV2 = withFirstTuple(launchCustomAsExported, toV2);

export type FactoryGeneration = "v2" | "v3" | "v4" | "v5";

export const factoryAbis: Record<FactoryGeneration, Abi> = {
  v2: replaceFn(replaceFn(hoodFactoryAbi as unknown as Abi, launchV2), launchCustomV2),
  v3: replaceFn(replaceFn(hoodFactoryAbi as unknown as Abi, launchV3), launchCustomV3),
  v4: replaceFn(replaceFn(hoodFactoryAbi as unknown as Abi, launchV4), launchCustomV4),
  v5: replaceFn(replaceFn(hoodFactoryAbi as unknown as Abi, launchV5), launchCustomV5),
};

export const launchSelectors: Record<FactoryGeneration, { launch: `0x${string}`; launchCustom: `0x${string}` }> = {
  v2: { launch: toFunctionSelector(launchV2), launchCustom: toFunctionSelector(launchCustomV2) },
  v3: { launch: toFunctionSelector(launchV3), launchCustom: toFunctionSelector(launchCustomV3) },
  v4: { launch: toFunctionSelector(launchV4), launchCustom: toFunctionSelector(launchCustomV4) },
  v5: { launch: toFunctionSelector(launchV5), launchCustom: toFunctionSelector(launchCustomV5) },
};

/// v3 and v4 take creator penalties; v4 takes the curve's opening rules; v5 names the open buyers
/// instead of either.
export const factoryTakesPenalties = (g: FactoryGeneration | undefined) => g === "v3" || g === "v4";
export const factoryTakesGuard = (g: FactoryGeneration | undefined) => g === "v4";
export const factoryTakesExempt = (g: FactoryGeneration | undefined) => g === "v5";

export function detectFactoryGeneration(code: `0x${string}` | undefined): FactoryGeneration | undefined {
  if (!code) return undefined;
  const hex = code.toLowerCase();
  if (hex.includes(launchSelectors.v5.launch.slice(2).toLowerCase())) return "v5";
  if (hex.includes(launchSelectors.v4.launch.slice(2).toLowerCase())) return "v4";
  if (hex.includes(launchSelectors.v3.launch.slice(2).toLowerCase())) return "v3";
  if (hex.includes(launchSelectors.v2.launch.slice(2).toLowerCase())) return "v2";
  return undefined;
}

// ---------------------------------------------------------------- block zero (team launches)

/// The periphery takes the factory's LaunchParams and the team's legs, so its shape follows the
/// factory's: v4 with penalties and the opening rules, v5 with the open buyers. Which one is
/// deployed is read off the periphery's own bytecode, the same way as the factory's.
const bzLaunchAsExported = fn(hoodBlockZeroAbi as unknown as Abi, "launch");
const bzLaunchCustomAsExported = fn(hoodBlockZeroAbi as unknown as Abi, "launchCustom");
const bzLaunchV4 = withFirstTuple(bzLaunchAsExported, toV4);
const bzLaunchCustomV4 = withFirstTuple(bzLaunchCustomAsExported, toV4);
const bzLaunchV5 = withFirstTuple(bzLaunchAsExported, toV5);
const bzLaunchCustomV5 = withFirstTuple(bzLaunchCustomAsExported, toV5);

export type BlockZeroGeneration = "v4" | "v5";

export const blockZeroAbis: Record<BlockZeroGeneration, Abi> = {
  v4: replaceFn(replaceFn(hoodBlockZeroAbi as unknown as Abi, bzLaunchV4), bzLaunchCustomV4),
  v5: replaceFn(replaceFn(hoodBlockZeroAbi as unknown as Abi, bzLaunchV5), bzLaunchCustomV5),
};

export const blockZeroSelectors: Record<BlockZeroGeneration, { launch: `0x${string}`; launchCustom: `0x${string}` }> = {
  v4: { launch: toFunctionSelector(bzLaunchV4), launchCustom: toFunctionSelector(bzLaunchCustomV4) },
  v5: { launch: toFunctionSelector(bzLaunchV5), launchCustom: toFunctionSelector(bzLaunchCustomV5) },
};

/// The most open buyers a v5 launch may name. SnipeSchedule.MAX_EXEMPT on chain.
export const MAX_OPEN_BUYERS = 32;

export function detectBlockZeroGeneration(code: `0x${string}` | undefined): BlockZeroGeneration | undefined {
  if (!code) return undefined;
  const hex = code.toLowerCase();
  if (hex.includes(blockZeroSelectors.v5.launch.slice(2).toLowerCase())) return "v5";
  if (hex.includes(blockZeroSelectors.v4.launch.slice(2).toLowerCase())) return "v4";
  return undefined;
}

// ---------------------------------------------------------------- the pinned selectors

/// What every generation has to come out to, read off the deployed contracts and the fresh v3
/// artifacts. A derivation that lands anywhere else would send a launch at a selector the contract
/// does not have, so this is checked when the module loads and printable from a shell:
///   node --experimental-strip-types -e "import('./apps/web/lib/launchAbi.ts').then(m => console.log(m.launchSelectorMismatches()))"
export const EXPECTED_LAUNCH_SELECTORS = {
  createLaunch: { legacy: "0x626a36e8", v2: "0x1d5a8281", v3: "0x896e053e", v4: "0xc2d44c33" },
  createTeamLaunch: { v4: "0x50b0e91b" },
  launch: { v2: "0xe0e22ce1", v3: "0xb3a7d553", v4: "0x313f39fb", v5: "0x2c649a35" },
  launchCustom: { v2: "0xa78faace", v3: "0x7741131c", v4: "0xf3f6982e", v5: "0x91dce6d4" },
  blockZeroLaunch: { v4: "0x47568507", v5: "0xa3a91013" },
  blockZeroLaunchCustom: { v4: "0xd6401ed6", v5: "0x83188dec" },
} as const;

/// Every derived selector that differs from its pinned value, as "name: derived != expected".
/// Empty is the only acceptable answer.
export function launchSelectorMismatches(): string[] {
  const out: string[] = [];
  const check = (name: string, derived: string, expected: string) => {
    if (derived.toLowerCase() !== expected.toLowerCase()) out.push(`${name}: ${derived} != ${expected}`);
  };
  for (const gen of ["legacy", "v2", "v3", "v4"] as const) check(`createLaunch.${gen}`, createLaunchSelectors[gen], EXPECTED_LAUNCH_SELECTORS.createLaunch[gen]);
  check("createTeamLaunch.v4", createTeamLaunchSelector, EXPECTED_LAUNCH_SELECTORS.createTeamLaunch.v4);
  for (const gen of ["v2", "v3", "v4", "v5"] as const) {
    check(`launch.${gen}`, launchSelectors[gen].launch, EXPECTED_LAUNCH_SELECTORS.launch[gen]);
    check(`launchCustom.${gen}`, launchSelectors[gen].launchCustom, EXPECTED_LAUNCH_SELECTORS.launchCustom[gen]);
  }
  for (const gen of ["v4", "v5"] as const) {
    check(`blockZero.launch.${gen}`, blockZeroSelectors[gen].launch, EXPECTED_LAUNCH_SELECTORS.blockZeroLaunch[gen]);
    check(`blockZero.launchCustom.${gen}`, blockZeroSelectors[gen].launchCustom, EXPECTED_LAUNCH_SELECTORS.blockZeroLaunchCustom[gen]);
  }
  return out;
}

{
  const mismatches = launchSelectorMismatches();
  if (mismatches.length) console.error(`launchAbi: the derived launch selectors are off, do not launch with this build: ${mismatches.join("; ")}`);
}

// ---------------------------------------------------------------- the form's side of it

/// What the penalties step holds. Percentages and minutes, the units a person thinks in; the
/// conversion to basis points and seconds happens once, in `encodePenalties`.
export interface PenaltyForm {
  jeetOn: boolean; jeetPct: number; jeetMinutes: number;
  whaleOn: boolean; whalePct: number; whaleTicks: number;
  kingOn: boolean; kingPct: number;
  lockersEat: boolean;
  auctionOn: boolean; auctionBlocks: number;
}

/// The wizard's defaults: every creator option off, with the value it takes the moment it is
/// turned on already in place, so a switch is one decision and not three.
export const PENALTY_FORM_DEFAULTS: PenaltyForm = {
  jeetOn: false, jeetPct: 5, jeetMinutes: 10,
  whaleOn: false, whalePct: 5, whaleTicks: 300,
  kingOn: false, kingPct: 20,
  lockersEat: false,
  auctionOn: false, auctionBlocks: 30,
};

export function encodePenalties(p: PenaltyForm): PenaltyConfig {
  return {
    jeetTaxBps: p.jeetOn ? Math.round(p.jeetPct * 100) : 0,
    jeetWindowSeconds: p.jeetOn ? Math.round(p.jeetMinutes * 60) : 0,
    whaleTaxBps: p.whaleOn ? Math.round(p.whalePct * 100) : 0,
    whaleTickLimit: p.whaleOn ? Math.round(p.whaleTicks) : 0,
    kingBps: p.kingOn ? Math.round(p.kingPct * 100) : 0,
    penaltiesToVault: p.lockersEat,
  };
}

export const encodeAuctionBlocks = (p: PenaltyForm) => p.auctionOn ? Math.round(p.auctionBlocks) : 0;

/// Whether anything at all is on. A launch with nothing on can still go to a v2 contract without
/// losing a choice the creator made, which is what decides whether the old ABI is acceptable.
export function penaltiesInUse(p: PenaltyForm): boolean {
  return p.jeetOn || p.whaleOn || p.kingOn || p.lockersEat || p.auctionOn;
}

/// The reason the encoded values would be refused on chain, or nothing.
export function penaltyProblem(p: PenaltyForm): string | undefined {
  const e = encodePenalties(p);
  if (e.jeetTaxBps > PENALTY_CAPS.jeetTaxBps) return "The jeet tax cannot go above 25%.";
  if (p.jeetOn && e.jeetWindowSeconds === 0) return "A jeet tax needs a window above zero.";
  if (e.jeetWindowSeconds > PENALTY_CAPS.jeetWindowSeconds) return "The jeet window cannot go past 60 minutes.";
  if (e.whaleTaxBps > PENALTY_CAPS.whaleTaxBps) return "The whale dump tax cannot go above 25%.";
  if (p.whaleOn && e.whaleTickLimit === 0) return "A whale dump tax needs a tick limit above zero.";
  if (e.whaleTickLimit > PENALTY_CAPS.whaleTickLimit) return "The tick limit cannot go past 2000.";
  if (e.kingBps > PENALTY_CAPS.kingBps) return "The king of the hill slice cannot go above 50%.";
  if (p.auctionOn && (p.auctionBlocks < 1 || p.auctionBlocks > PENALTY_CAPS.auctionBlocks)) return "The auction must last between 1 and 300 blocks.";
  return undefined;
}

/// One line per penalty that is on, for the review step. Nothing on is one honest line.
export function penaltyReviewRows(p: PenaltyForm, opts: { snipe?: { pct: number; seconds: number }; postGraduation?: boolean } = {}): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  if (opts.snipe) {
    rows.push({ label: "Snipe tax", value: opts.snipe.pct > 0 ? `${opts.snipe.pct}% extra at the open, gone after ${opts.snipe.seconds}s, paid to holders` : "Off" });
  }
  const to = p.lockersEat ? "Vault lockers" : "holders";
  if (p.jeetOn) rows.push({ label: "Jeet tax", value: `${p.jeetPct}% on a sell within ${p.jeetMinutes} min of buying, to ${to}` });
  if (p.whaleOn) rows.push({ label: "Whale dump tax", value: `${p.whalePct}% on a sell that moves the pool past ${p.whaleTicks} ticks, to ${to}` });
  if (p.kingOn) rows.push({ label: "King of the hill", value: `${p.kingPct}% of every sell tax fills the pot; the last buyer after 60 s of quiet wins it` });
  if (p.lockersEat) rows.push({ label: "Lockers eat the jeets", value: "Jeet and whale taxes go to Vault lockers instead of holders" });
  if (p.auctionOn) rows.push({ label: "Sniper auction", value: `The first slot is auctioned for ${p.auctionBlocks} blocks; half to holders, half into locked liquidity` });
  if (!p.jeetOn && !p.whaleOn && !p.kingOn && !p.lockersEat && !p.auctionOn) {
    rows.push({ label: "Creator penalties", value: opts.postGraduation ? "None after graduation" : "None beyond the defaults" });
  }
  return rows;
}
