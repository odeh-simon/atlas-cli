import type { MaterialChangeCategory } from "@sigil/domain";
import type { ImplementationContract } from "@sigil/schemas";

export interface ContractSectionDiff {
  readonly section: string;
  readonly category: MaterialChangeCategory;
  readonly material: boolean;
  readonly summary: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface ContractDiffResult {
  readonly hasChanges: boolean;
  readonly requiresReapproval: boolean;
  readonly changes: readonly ContractSectionDiff[];
}

interface SectionSpec {
  readonly section: string;
  readonly category: MaterialChangeCategory;
  readonly material: boolean;
  readonly select: (contract: ImplementationContract) => unknown;
}

const sectionSpecs: readonly SectionSpec[] = [
  { section: "objective", category: "scope", material: true, select: (contract) => contract.objective },
  { section: "scope", category: "scope", material: true, select: (contract) => contract.scope },
  {
    section: "approved_decisions",
    category: "architecture",
    material: true,
    select: (contract) => contract.approved_decisions
  },
  {
    section: "technical_approach",
    category: "architecture",
    material: true,
    select: (contract) => contract.technical_approach
  },
  {
    section: "affected_subsystems",
    category: "architecture",
    material: true,
    select: (contract) => contract.affected_subsystems
  },
  { section: "constraints", category: "design_constraints", material: true, select: (contract) => contract.constraints },
  {
    section: "data_state_permissions",
    category: "data_security",
    material: true,
    select: (contract) => contract.data_state_permissions
  },
  { section: "required_states", category: "acceptance", material: true, select: (contract) => contract.required_states },
  {
    section: "accessibility_observability",
    category: "design_constraints",
    material: false,
    select: (contract) => contract.accessibility_observability
  },
  { section: "edge_cases", category: "acceptance", material: true, select: (contract) => contract.edge_cases },
  {
    section: "acceptance_criteria",
    category: "acceptance",
    material: true,
    select: (contract) => contract.acceptance_criteria
  },
  {
    section: "tests_and_validation",
    category: "tests",
    material: true,
    select: (contract) => contract.tests_and_validation
  },
  { section: "prohibitions", category: "prohibitions", material: true, select: (contract) => contract.prohibitions },
  {
    section: "unresolved_questions",
    category: "acceptance",
    material: false,
    select: (contract) => contract.unresolved_questions
  }
];

export function diffImplementationContracts(
  previous: ImplementationContract,
  next: ImplementationContract
): ContractDiffResult {
  const changes = sectionSpecs.flatMap((spec) => {
    const before = spec.select(previous);
    const after = spec.select(next);
    if (stableStringify(before) === stableStringify(after)) return [];
    return [
      {
        section: spec.section,
        category: spec.category,
        material: spec.material,
        summary: `${spec.section} changed`,
        before,
        after
      }
    ];
  });

  return {
    hasChanges: changes.length > 0,
    requiresReapproval: changes.some((change) => change.material),
    changes
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortObject(value));
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (typeof value !== "object" || value === null) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortObject((value as Record<string, unknown>)[key]);
  }
  return sorted;
}
