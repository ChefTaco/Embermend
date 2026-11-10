# Embermend Product Specification

**Product:** Embermend by HiveMagnus  
**Descriptor:** Continuous hardening and vulnerability remediation  
**Version:** 1.0  
**Date:** November 9, 2026  
**Status:** Product specification for agent planning

## 1. Purpose and product goal

Embermend continuously identifies security weaknesses in Magnus-managed infrastructure and associated applications, explains a recommended remediation plan to the operator, coordinates authorized changes through AI agents and deterministic execution services, and verifies the resulting security state.

The product covers host hardening, vulnerable software, container images and workloads, application code vulnerabilities, and the relationships among repositories, builds, deployments, and managed systems. Its primary outcome is completed, evidenced remediation with continued detection of drift and recurrence.

The normal operator experience is conversational and exception-driven. The AI prepares the work, explains its recommendation, performs actions authorized by policy or an explicit decision, follows execution and verification, and returns a concise outcome. Operators set intent and boundaries, review recommendations when necessary, and intervene when judgment is needed.

This document defines the complete intended product and its acceptance requirements. The planning agent determines implementation sequencing, work decomposition, and detailed technical design.

### 1.1 Binding product decisions

1. The product name is **Embermend**.
2. A compatible **Magnus installation is required**. Embermend has no standalone operating mode.
3. Every host that Embermend directly assesses or changes, including repository scan and build workers, must have a compatible, enrolled Magnus agent.
4. Magnus owns host enrollment, agent lifecycle, supported execution capabilities, command admission, resource ownership, and execution receipts.
5. Embermend owns security assessment state, prioritization, remediation intent, plans, automation policy, exceptions, and verification.
6. AI agents lead remediation after explaining the recommended plan to the operator. Explicit standing policies can authorize execution without acknowledgment of every recommendation.
7. Detailed operator dashboards, page layouts, and a manual remediation workbench are outside this specification. The product must provide concise interaction and access to supporting evidence.
8. Application-level vulnerabilities and repository relationships are required product capabilities.
9. Embermend must drive a working custom AI code scanner through a defined integration boundary.
10. The asset and execution contracts must accommodate future Magnus agents running inside containers. Building and distributing those agents remains a Magnus responsibility.
11. A finding is resolved only when the relevant outcome is verified. Execution completion, source changes, release creation, and deployment are distinct facts.

### 1.2 Requirement language

**MUST** identifies a required outcome or constraint. **SHOULD** identifies the preferred behavior; an alternative must preserve the intended outcome and be explained by the planning agent. **MAY** identifies supported design freedom.

Requirements are product behavior, not claims that the current repositories already implement them. Existing capabilities and integration constraints are summarized in Section 18.

## 2. Scope and completion boundary

### 2.1 Required capabilities

The finished product MUST provide:

- Discovery and reconciliation of eligible Magnus-managed hosts and observed workloads.
- Configuration assessment against versioned hardening profiles.
- Assessment and prioritization of relevant host, dependency, image, and application vulnerabilities.
- Application inventory with repository, source revision, build artifact, deployment, and managed-target relationships.
- Orchestration of a custom AI code scanner, including scan coverage, findings, evidence, and validation status.
- AI-generated remediation recommendations tied to structured, revisioned plans.
- Policy-authorized or explicitly approved host, configuration, repository, build, and deployment actions within supported capabilities.
- Coordination of related changes, maintenance windows, dependencies, and staged execution.
- Verification of security outcomes and relevant operational health.
- Recurrence detection, exceptions, ownership, and coverage reporting.
- Typed APIs, agent tools, and machine-readable exports that support the primary AI workflow.
- A concise operator interaction surface integrated with the HiveMagnus suite.

### 2.2 Supported reference environment

Ubuntu 24.04 is the required host reference platform. The product MUST support meaningful hardening and vendor-supported security package remediation on this platform through Magnus.

Docker/OCI images and Docker Compose workloads on Magnus-managed hosts are the required container reference environment. Container assessment and deployment operations use supported host-agent capabilities until container-resident agents are available.

GitHub is the required repository reference provider. TypeScript/JavaScript applications are the required custom-scanner reference language family, including a repository containing more than one application.

These reference targets make acceptance concrete. The architecture MUST advertise platform, language, and action capabilities explicitly so additional supported targets can be added without changing the core finding and remediation model. Unsupported targets MUST remain visible as coverage limitations.

### 2.3 Deliberate exclusions

The product goal does not require:

- An independent Embermend endpoint agent, host enrollment service, or direct SSH execution path.
- A full security information and event management system, endpoint detection product, or incident investigation console.
- A generic internet-wide discovery engine or unrestricted attack simulation.
- Universal language, operating-system, cloud, or vulnerability coverage.
- A replacement for repository hosting, CI/CD, identity, or source-control review systems.
- A detailed graphical remediation workbench or a new general-purpose chat platform.
- A new fleet of always-on microservices where existing suite components or a simpler implementation meet the requirements.
- Implementation of the future Magnus container agent.

External security tools may enrich the product. They do not replace the required managed-host and custom code-scanner workflows.

## 3. Users, responsibilities, and product boundaries

### 3.1 Operator and application owner

The operator defines security objectives, target groups, automation permissions, maintenance constraints, and escalation destinations. The operator can approve or reject a plan when required, narrow its scope, pause further work, request an explanation, or accept a time-bounded exception.

Application and service owners provide business importance, source ownership, deployment context, and operational constraints. The product SHOULD resolve ownership from configured application metadata, repository ownership, and fleet labels, while showing unresolved or conflicting ownership.

### 3.2 AI remediation coordinator

An Ardent agent or equivalent supported suite agent acts as the remediation coordinator. Its responsibilities include interpreting evidence, proposing priorities, grouping related fixes, producing the operator explanation, preparing source changes, following authorized execution, and explaining exceptions.

The coordinator MUST act through typed Embermend tools and supported integrations. Its reasoning does not itself establish execution authority, vulnerability validity, or successful remediation.

The product MUST support provider configuration compatible with the suite's model infrastructure, including approved local OpenAI-compatible model services. It MUST NOT require a particular commercial model provider.

### 3.3 Deterministic Embermend services

Embermend services own the authoritative records and enforce schemas, authorization, plan revisions, target selection, execution eligibility, and verification rules. These services remain usable for inspection, reconciliation, and already-authorized deterministic work when model inference is unavailable.

### 3.4 Magnus

Magnus is the required host-management and execution dependency. Embermend MUST reuse Magnus inventory identities and supported operations instead of establishing parallel host credentials or management channels.

If an action requires an unavailable Magnus capability, Embermend MUST identify the blocker and retain the outstanding security work. The implementation MUST add the necessary bounded Magnus actions for required product behavior rather than bypass a refusal.

### 3.5 Other HiveMagnus products

| Product | Embermend relationship |
| --- | --- |
| Hive | Installs and registers the product, its required dependencies, and compatible release metadata. |
| HiveXUI | Provides a compact operator entry point and access to recommendation, decision, status, and evidence interactions. |
| Oathweave | Supplies suite identity and scoped access. Embermend must apply its own operation permissions using the established suite identity model. |
| Ardent | Hosts the remediation coordinator and other delegated analysis or code-change tasks. |
| Emberpath | Can supply model routing under the operator's configured provider and data policies. |
| Cindertrace | Optionally supplies incident and exploitation context and receives linked remediation evidence. It retains investigation and containment authority. |
| HiveSkills and HiveMem | May supply approved working methods and operational knowledge. Neither is the authoritative store for findings, authorization, or verification. |
| ChatterMost or existing suite conversation surfaces | Can carry recommendations, decisions, progress, and completion notices through authenticated integrations. |

Cindertrace, Wazuh, and other external assessment systems MUST NOT become prerequisites for the core Embermend workflows.

## 4. Required product journeys

### 4.1 Continuous hardening

An operator assigns a hardening profile and automation policy to an application or host group. Embermend gathers current evidence, identifies deviations, and asks the AI to explain a recommended plan. Eligible changes execute through Magnus according to the policy and operational constraints. Fresh checks establish the outcome, and later assessment identifies recurrence.

### 4.2 Vulnerability remediation

A new advisory or updated assessment identifies affected software. Embermend determines applicability, affected assets and deployments, fix availability, and urgency. The AI proposes a campaign that addresses shared causes and explains service impact. The product coordinates updates, restarts or reboots where required, and verifies the affected software and running state.

### 4.3 Application code remediation

A repository event, scheduled assessment, or operator request starts a custom AI scan against an immutable source revision. Findings are linked to the application and known deployments. The AI explains a proposed fix, prepares an isolated source change under the applicable policy, runs permitted validation, and creates or updates a pull request.

Merge and deployment follow their own permissions. Embermend tracks the fix through source validation, resulting build artifacts, deployed versions, and runtime verification. A merged fix can be reported as source remediation while affected deployments remain open.

### 4.4 Coordinated application and infrastructure remediation

A weakness may require changes in more than one place: application code, an image, deployment configuration, or a host. Embermend MUST express the dependencies in one coherent plan and keep evidence for each action and target.

For example, a temporary network restriction can reduce exposure while a source fix is built and deployed. The mitigation remains distinct from removal of the underlying defect, and removing the temporary control is a separately authorized action.

### 4.5 Investigation and intervention

The operator can ask why a finding is prioritized, what changed, why execution stopped, which deployments remain affected, or what evidence supports closure. The AI answers from retained records and cites the relevant evidence.

A pause prevents new dispatch after the authoritative pause takes effect. Work already admitted or running MUST be shown accurately and handled according to the execution contract.

## 5. Domain model and identity

The following logical entities are required. The planning agent may choose their physical schemas and storage layout.

| Entity | Required meaning |
| --- | --- |
| Application | A logical application or service with ownership, importance, environments, and operational constraints. |
| Repository | A source repository identified by provider instance and stable provider identity, with current location and access configuration. |
| Application source binding | The repository, paths, manifests, branches, and build definitions associated with an application. |
| Source revision | An immutable commit or equivalent revision, with branch context recorded separately. |
| Build artifact | An immutable artifact or image digest with available source and build provenance. |
| Deployment or workload | A logical deployed application version in an environment, linked to artifacts and runtime instances. |
| Managed host | A Magnus target with stable identity, capabilities, lifecycle, and observed configuration. |
| Container instance | A particular runtime instance, distinct from its image and logical workload. |
| Management agent | The Magnus identity and capabilities through which a target is observed or operated. |
| Assessment or scan run | A bounded assessment with declared scope, actual coverage, versions, evidence, and completion state. |
| Observation | What a source reported at a specific time and scope, retaining source provenance. |
| Finding | A persistent security weakness or supported defect, with affected occurrences and linked observations. |
| Finding occurrence | A weakness affecting a particular asset, component, source revision, branch, artifact, or deployment. |
| Hardening profile and rule | A versioned desired-state definition and its applicability, assessment, and remediation mapping. |
| Remediation action | A versioned supported operation with parameters, prerequisites, effect boundaries, and verification requirements. |
| Remediation plan | A revisioned recommendation binding findings, actions, targets, dependencies, impact, and authorization requirements. |
| Campaign | A grouping of related plans or actions whose progress and security outcome can be followed together. |
| Execution attempt | The identity, receipt, state, and result of a particular dispatched operation. |
| Verification | Fresh evidence establishing the security and operational outcome for a defined scope. |
| Exception | An authorized acceptance or deferral with scope, rationale, ownership, expiry, and compensating controls. |

### 5.1 Relationships and provenance

The product MUST represent this relationship when evidence exists:

**Application → repository and source revision → build artifact or image digest → deployment → managed runtime target.**

The relationship is many-to-many. One repository may contain several applications, and one application may be assembled from several repositories. One artifact may be deployed many times.

Each relationship MUST record its source and whether it is established or inferred. Build records, manifests, operator declarations, and runtime observations may provide different levels of assurance. Unknown provenance MUST remain explicit.

A branch, IP address, hostname, image tag, container name, or file path alone MUST NOT establish immutable identity.

Repository renames and location changes MUST preserve history when the stable identity matches. Access must be reevaluated after a repository transfer or credential change.

Applications and source findings may exist without a known deployment. This is a useful assessed state; the product MUST show that deployment exposure is unknown rather than assuming it is absent.

### 5.2 Finding identity and grouping

A finding's identity MUST account for the affected component and underlying weakness. CVE, CWE, rule identifier, path, or line number alone is insufficient for every finding type.

The product SHOULD preserve identity across supported file renames, line movement, repeat scans, and workload replacement when evidence supports the match. Uncertain matches must remain reviewable.

Multiple sources may contribute observations to one finding. Their evidence, timestamps, and disagreements MUST remain available. Grouping findings into a common remediation does not erase their individual applicability or outcomes.

## 6. Asset discovery, assessment, and coverage

### 6.1 Managed inventory

Embermend MUST reconcile Magnus inventory and discover relevant packages, services, listeners, configuration, images, and workloads through supported assessment actions.

It MUST retain the Magnus installation and target identity for each managed host. Enrollment, freshness, compatibility, and capability limitations MUST be visible to the coordinator.

An asset discovered through DNS, repository metadata, imported evidence, or workload configuration may be recorded before it is managed. Embermend MUST distinguish discovered, attributed, assessed, and eligible-for-execution states. A discovered host without an enrolled Magnus agent cannot receive host assessment or mutation actions.

### 6.2 Exposure context

Exposure observations MUST identify what was reachable, from which configured vantage point, and when. An internal listening socket alone does not establish internet reachability.

External or network checks MUST be scoped to operator-authorized targets and run through an eligible managed worker or host capability. Ownership and scope boundaries must persist across scheduled work.

### 6.3 Assessment lifecycle

Assessments MUST support operator requests, schedules, and relevant change events, including software inventory changes, deployment events, repository updates, profile changes, and new advisory information.

Each run MUST retain requested scope, actual coverage, assessment version, source/feed timestamps, completion status, and errors. The system MUST distinguish complete, partial, failed, canceled, unsupported, and stale assessments.

No results, a disconnected agent, reduced scan scope, or a failed connector MUST NOT count as a clean assessment. Posture summaries must include coverage and freshness.

### 6.4 Collection boundaries

Evidence collection SHOULD obtain the minimum relevant content. Secret values must be redacted or replaced by protected references before ordinary notifications, general model context, or routine logs receive the evidence.

Imported observations MUST retain their source identity and be schema-validated. Source text and scanner explanations are evidence, not instructions that change the coordinator's permissions.

## 7. Hardening and infrastructure vulnerability requirements

### 7.1 Hardening profiles

Profiles MUST support explicit platform applicability, versioning, assignment to applications or target groups, and scoped overrides or exceptions.

Required profile coverage includes:

- Ubuntu host configuration, including effective SSH policy, approved services and listeners, selected sensitive file permissions, firewall posture, and security update state.
- Container host and workload posture, including privileged execution, relevant host mounts, runtime socket access, network exposure, and image/deployment configuration.
- HiveMagnus service posture, including management endpoint exposure, protected service configuration, credential-file permissions, and approved model-service reachability.

Each rule MUST state what it checks, how it determines applicability, what evidence supports its result, why the condition matters, and which remediation actions are supported.

Results MUST distinguish pass, fail, not applicable, not assessed, and assessment error. An exception remains separately visible.

A profile revision MUST support an impact assessment showing new or changed findings and proposed work before any newly introduced change is eligible to execute.

### 7.2 Software vulnerability applicability

Vulnerability records MUST retain package/component identity, installation source, platform and distribution, installed version, advisory source, applicable fixed versions, fix availability, and assessment time where relevant.

OS-managed packages MUST use distribution-aware applicability and version comparison. The implementation must handle vendor backports and platform-specific advisory decisions. It MUST NOT classify all software solely by upstream version strings or a generic product-name match.

The product MUST distinguish vulnerable, not affected according to supported evidence, unresolved applicability, no available fix, unsupported software, and end-of-support conditions.

Host packages, application dependencies, container layers, and source defects MUST remain distinguishable even when they share an advisory identifier.

### 7.3 Prioritization

Priority MUST consider available evidence about exploitation, exposure, asset importance, technical consequence, remediation availability, age, and applicable owner commitments.

Known exploited vulnerability information and EPSS enrichment MUST be supported for applicable CVEs. The product MUST retain the source and date of enrichment. EPSS represents exploitation likelihood for a CVE over its defined forecast period and must not be presented as the compromise probability of a particular asset. [FIRST EPSS definition](https://www.first.org/epss/)

Severity, evidence confidence, and operational priority MUST be separate attributes. The AI may recommend priority adjustments, but the explanation must identify the evidence and policy used.

Missing exposure or ownership data must remain visible as uncertainty. It must not silently reduce the priority to zero.

### 7.4 Reused assessment content

The implementation SHOULD reuse maintained assessment engines and vendor data through adapters where they fit. Magnus inventory, Trivy, OpenSCAP/Ubuntu OVAL, and optional Wazuh ingestion are suitable integration candidates.

Rule and advisory sources MUST be versioned or time-stamped sufficiently to explain changes in findings. Redistribution and marketing must respect the selected content's terms. The product must describe the scope it actually assesses.

## 8. Custom AI code scanner and application security

### 8.1 Required working integration

Embermend MUST drive a custom AI code scanner against authorized repository content and receive usable application vulnerability findings. A placeholder adapter, imported sample results, or a dependency-only scan does not satisfy this requirement.

The planning agent may reuse an available custom scanner or implement the scanner capability needed to satisfy the product goal. The scanner may be a package, managed command, or service behind the integration boundary; this specification does not require a new independently deployed scanner product.

Repository checkouts, code analysis that executes tooling, patch preparation, and local build/test work MUST use an eligible Magnus-managed worker. Any separately hosted analysis service receives source only under the configured repository and model-provider policy.

### 8.2 Scan request contract

Every request MUST bind:

- Stable repository identity and immutable source revision.
- Application scope and included and excluded paths.
- Relevant branch or pull-request context.
- Requested analysis profile and supported language or framework capabilities.
- Relevant dependency, build, and deployment context when available.
- Resource limits, deadline, cancellation identity, and source-access policy.
- Magnus worker and operation identity where work executes through Magnus.

Branch names and mutable pull-request heads must be resolved to immutable revisions before analysis.

### 8.3 Scan result contract

The scanner MUST expose asynchronous job status, incremental or final results, cancellation, and terminal completion state.

Every result MUST record scanner version, analysis profile, model configuration reference, actual coverage, exclusions, failures, and the scanned revision. It MUST identify unsupported languages and files it did not examine.

A finding result MUST include the affected component and location, a concise description of the weakness, supporting evidence, relevant assumptions, severity, confidence, and validation status. CVE and CWE identifiers are optional classifications; their absence must not prevent a code finding.

The product MUST support findings about code-level behavior, including supported forms of injection, unsafe input or path handling, missing authorization, insecure trust boundaries, exposed secrets, and unsafe configuration. Capability declarations must make clear which classes were actually assessed.

Business-logic and authorization findings may require contextual review. Model confidence alone MUST NOT turn a hypothesis into a confirmed defect.

### 8.4 Candidate findings and validation

Scanner hypotheses MUST remain distinguishable from findings supported by reproducible analysis, a focused test, or recorded technical review.

Validation MUST record the method, evidence, applicable revision, and limitations. Live exploitation of a production application is not required to confirm a source finding and must not be an implicit scanner behavior.

The same scanner repeating its conclusion is not sufficient independent evidence of a successful fix. Verification SHOULD combine relevant rescanning with a focused regression check, supported static evidence, or explicit technical review appropriate to the defect.

False-positive decisions and disagreements MUST retain their rationale and scope. A decision on one revision must not automatically suppress a materially changed implementation.

### 8.5 Coverage and incremental analysis

The scanner MUST distinguish full-scope analysis from incremental analysis. Incremental results must identify which paths and relationships were examined and which earlier observations remain unrefreshed.

Absence of a finding establishes resolution only when the reassessment covered the affected component with an appropriate method. A failed scan, excluded path, unsupported language, changed rule set, or truncated model task cannot close a finding by omission.

### 8.6 Repository content and execution boundaries

Repository files, comments, documentation, dependency scripts, and scanner output MUST be treated as untrusted input. They cannot grant new credentials, change authorization, expand the scan target, or direct the AI to perform unrelated actions.

Reading source, executing repository-provided code, writing a branch, opening a pull request, merging, and deploying are distinct operations. Dependencies and project scripts may run only in the authorized worker environment and scope.

Repository-provided code, dependency scripts, builds, and tests MUST execute within an isolated checkout and execution environment that excludes Magnus agent credentials, host administration resources, unrelated workspaces, and repository write or deployment credentials. Authorized provider writes MUST use bounded integration operations outside that environment.

Ordinary scan/model contexts MUST NOT receive repository write or deployment credentials. Credentialed provider operations should use the owning integration's bounded operations.

## 9. AI planning, explanation, and authorization

### 9.1 Structured recommendation

The AI MUST produce a structured remediation plan with a concise operator explanation. Free-form advice alone does not constitute an executable plan.

Each plan revision MUST identify:

- The security objective and findings addressed.
- Supporting evidence and relevant uncertainty.
- Exact target assets, applications, repositories, revisions, and deployments.
- Proposed actions, action versions, and bounded parameters.
- Dependencies and the intended order of changes.
- Expected security improvement.
- Expected service impact, restarts, reboots, and compatibility consequences.
- Applicable execution windows, resource constraints, and stopping conditions.
- Validation and verification procedures.
- Recovery options and their limitations.
- Applicable standing authorization or the decision still required.

The explanation SHOULD emphasize why this plan is recommended, what the operator needs to understand, and any material alternatives.

### 9.2 Explanation before mutation

Before an action changes managed system configuration, persistent repository state, published artifacts, or deployments, its plan explanation MUST be durably recorded and published to the configured operator interaction surface.

An explicitly authorized assessment or preparation policy MAY permit temporary checkouts, analysis artifacts, and isolated draft patches before the final recommendation is published. These activities allow the AI to prepare an accurate plan and diff. They must remain within the worker isolation and execution permissions in Section 8.6.

Writing a durable remediation commit or branch, pushing changes, opening a pull request, changing a managed system, publishing an artifact, and deploying MUST satisfy the explanation requirement. Preparation authority does not authorize these actions.

The explanation must identify the exact plan revision and whether execution will proceed under standing policy or wait for a decision. A failed attempt to publish to the required primary surface blocks dispatch. Optional secondary notification failures follow the configured delivery policy.

Publishing a recommendation is not authorization. Operator silence, elapsed time, urgency, and successful notification delivery MUST NOT be interpreted as approval.

For a plan covered by explicit standing authorization, the product MAY proceed automatically after publishing the explanation without requiring acknowledgment. A policy may define a delay or scheduled window where appropriate.

### 9.3 Automation policies

Policies MUST specify allowed action classes, target selectors, environments, applicable repository branches, execution windows, disruption limits, and required verification or recovery conditions.

The product MUST distinguish authority to:

- Assess and collect evidence.
- Prepare a recommendation or source patch.
- Write an authorized working branch and create or update a pull request.
- Apply host or configuration changes.
- Merge source changes.
- Build or publish an artifact.
- Deploy or restart a workload.
- Accept an exception or authorize recovery.

These permissions can be bundled by an explicit policy, but one action must not imply the others.

The default in the absence of a matching mutation policy is to explain and request the required decision. Read-only assessment can continue within its authorized scope.

### 9.4 Plan revisions and current-state checks

Authorization MUST bind to the material contents of the plan and dispatched operation.

Before dispatch, deterministic services MUST verify current policy, target identity, required capabilities, preconditions, and action parameters. A changed source head, expanded target set, altered patch, changed operational impact, or revoked policy requires reevaluation.

A revised plan that remains within an explicit standing policy may be explained again and authorized automatically. A revision outside that policy requires a new operator decision. Approval of an older revision must not silently transfer to expanded work.

### 9.5 AI autonomy and bounded recovery

The AI MAY choose among supported actions, group common fixes, prepare patches, interpret test failures, and revise work within authorized scope and configured limits.

It MUST NOT change its own authority or promote an unreviewed generated script into a privileged production action. New action implementations require the catalog's validation and publication process.

Repeated failures, insufficient evidence, exhausted resource budgets, or unavailable capabilities must produce a clear blocker. The coordinator must avoid unbounded retry loops.

## 10. Remediation actions and execution

### 10.1 Action definition

Each executable action MUST have a versioned contract describing:

- Supported target kinds, platform versions, and required Magnus capabilities.
- Bounded input schema and affected resources.
- Applicability, prerequisites, and expected pre-change state.
- Intended change and a preview or diff where meaningful.
- Idempotency and concurrency behavior.
- Possible reload, restart, reboot, or deployment consequences.
- Execution completion evidence.
- Separate security and service-health verification.
- Recovery procedure or an explicit statement of recovery limits.

### 10.2 Host and configuration actions

Required host actions MUST include vendor-supported security package updates and a useful set of reversible hardening changes on the reference platform.

Package remediation MUST account for dependencies, held packages, package-manager locks, available repositories, interrupted transactions, and required process or kernel activation. A package installed on disk does not prove that all affected running software has changed.

Configuration actions MUST validate syntax where applicable and inspect effective configuration after applying the change. Changes to remote management or authentication require verified preservation of an authorized management path.

### 10.3 Repository remediation

The AI MUST be able to prepare an isolated working change against a known base revision, produce an inspectable diff, perform allowed validation, and create or update a linked pull request.

Each source remediation MUST preserve links to the findings, plan revision, branch, pull request, test results, and resulting commit.

Protected branches, repository permissions, required checks, and review rules remain authoritative. Embermend MUST NOT disable or bypass them.

Merge authorization and deployment authorization are distinct. A plan that allows a pull request does not inherently authorize either.

A changed base or pull-request head MUST trigger relevant validation and authorization reevaluation. A previously reviewed diff must not stand in for a different final change.

### 10.4 Build and deployment remediation

The product MUST follow source changes through supported build and deployment integrations. Local build and deployment work runs through an eligible Magnus-managed worker; external CI operations use a configured provider integration with recorded run identity.

Artifact publication and deployment MUST preserve immutable artifact identity and available source provenance.

Container remediation SHOULD update the controlling source, image, or deployment configuration. A mutable image tag is not sufficient proof of the artifact that was assessed or deployed.

### 10.5 Campaign coordination

Campaigns MUST support dependency ordering, canary or staged execution, application-aware disruption constraints, and stopping subsequent work when required checks fail.

The product MUST prevent conflicting work on the same affected resource through Magnus's existing ownership mechanisms and any necessary application-level coordination.

Temporary mitigations and permanent fixes may coexist in a campaign, with distinct verification and removal requirements.

### 10.6 Magnus execution contract

The logical request MUST include plan identity and revision, operation identity, action version, Magnus installation and target, bounded parameters, required capabilities, preconditions, authorization reference, deadline or execution window, and verification references.

Magnus MUST provide durable execution identity and receipt semantics that Embermend can query after interrupted communications.

Embermend MUST NOT bypass a denied or unsupported Magnus operation through direct SSH, direct agent access, or an equivalent arbitrary-shell request.

## 11. Verification and finding lifecycle

### 11.1 Separate state dimensions

The data model MUST represent these dimensions independently:

| Dimension | Examples of meaningful states |
| --- | --- |
| Evidence validity | Candidate, validated, disputed, false positive with rationale |
| Assessment coverage | Complete, partial, unsupported, stale, failed |
| Execution | Planned, authorized, queued, running, completed, failed, unknown, reconciled |
| Source remediation | Open, change proposed, fixed and verified at specified revision |
| Deployment remediation | Affected, awaiting deployment, awaiting verification, verified mitigated, verified resolved |
| Exception | Active, expired, withdrawn, superseded |

The planner may choose concrete names, but the distinctions MUST survive storage, APIs, agent tools, and summaries.

### 11.2 Execution is not verification

A successful exit code, command receipt, fresh heartbeat, created pull request, successful build, or merged commit establishes only its corresponding fact.

Verified closure requires fresh evidence covering the original weakness at the relevant scope and appropriate operational health checks. Checks must identify the target, revision or artifact, observation time, and method.

Missing evidence MUST leave the affected verification dimension outstanding: an offline runtime target or unknown deployed artifact blocks runtime closure; incomplete relevant source analysis blocks source verification; stale package inventory blocks the corresponding package assessment. Unrelated verification dimensions may complete independently.

### 11.3 Source and runtime outcomes

A source defect fixed on one branch remains open where it still occurs on other maintained branches or deployed artifacts.

The product MUST report source remediation and runtime remediation separately. For example: the source fix is verified at a particular commit, a new image is available, and production still runs an affected digest.

Runtime closure requires evidence connecting the actual deployment to an assessed fixed artifact or equivalent validated change. Inferred or absent provenance must limit the claim accordingly.

If no deployment is known, source remediation can complete while deployment exposure remains unknown. The system must not invent a runtime verification requirement for an application explicitly registered as source-only.

For exposed-secret findings, source cleanup and credential containment MUST be tracked separately. Verified resolution requires evidence of revocation, rotation, expiry, or another effective invalidation through the owning credential system, together with any required consumer migration. Source deletion or masking alone cannot close credential exposure. Owner-supplied or integrated evidence may establish invalidation; a universal credential-management subsystem is not required. Repository-history rewriting is a separate, explicitly authorized operation.

### 11.4 Mitigation, retirement, and acceptance

A compensating control may establish verified mitigation while the underlying vulnerability remains. The plan must state the protection provided and any residual exposure.

Removing an affected component or retiring a deployment may resolve a scoped occurrence when supported by fresh evidence. Historical findings and execution records remain available.

An accepted exception is a risk decision, not a technical fix. It must remain separately represented in summaries.

### 11.5 Recurrence

The product MUST detect reintroduced configuration drift, reverted patches, reintroduced dependencies, redeployment of affected artifacts, and materially changed code that invalidates a previous suppression.

Recurrence must reopen an occurrence or create a linked occurrence without erasing the previous verification history.

### 11.6 Unknown execution outcomes

Lost replies, timeouts, canceled tasks, and disconnected agents MUST NOT be treated as proof that a mutating action stopped or had no effect.

The original operation MUST be reconciled through Magnus's receipt and ownership semantics. A new operation identifier must not be used merely to replay unresolved work.

Authorized read-only checks may gather evidence while an outcome is uncertain. Observing the desired state alone does not release Magnus execution ownership where its protocol requires additional completion evidence.

### 11.7 Recovery

Recovery is an explicit action with its own authorization and verification.

Plans MUST distinguish configuration restoration, deployment rollback, package downgrade, data restoration, and forward repair. They must not promise automatic rollback where the platform or action cannot support it.

## 12. Container model and future container agents

### 12.1 Current managed-container behavior

Host agents assess and operate containers only through supported Magnus capabilities. Embermend MUST track the logical workload, image digest, particular runtime instance, deployment configuration, and managing host separately.

Replacing a container creates a new instance identity while preserving the workload and application history. Verification for the old instance must not automatically transfer to its replacement.

If a replacement uses the same affected image, the image finding persists even when the container identity changes.

### 12.2 Future agent compatibility

The end product MUST provide target-kind and capability abstractions that can register and consume observations from a future Magnus container agent without rewriting the application, finding, or plan models.

The contract MUST accommodate the container agent's own Magnus identity, workload and instance linkage, execution namespace, lifetime, supported operations, and parent-host relationship where known.

A container agent's enrollment MUST NOT imply authority over its parent host, sibling containers, runtime socket, or entire deployment.

Embermend must choose an execution target whose authority matches the requested change. An in-container action, an image rebuild, a host configuration change, and a workload rollout are different operations.

### 12.3 Durable resolution

An in-container mutation that disappears when the container is replaced cannot establish durable remediation while the controlling image or deployment still reproduces the weakness.

Such a change may be tracked as a temporary mitigation if verified and authorized. Durable closure requires evidence that the controlling artifact or desired state is corrected and the relevant deployment reflects it.

The compatibility requirement MUST be verified using contract fixtures or a suitable test adapter until a real container agent exists. Production support must not be claimed solely from a simulated agent.

## 13. Integration and implementation constraints

### 13.1 Product structure

Embermend SHOULD have its own repository, public API contracts, data ownership, and release identity while remaining a Magnus-dependent product.

The implementation SHOULD use the suite's established TypeScript, API, persistence, identity, and deployment patterns. The planning agent selects the concrete internal layout and queue technology.

A conventional service with durable workers and PostgreSQL is an appropriate default. Additional infrastructure must solve a demonstrated requirement.

### 13.2 Authoritative data and jobs

Findings, plans, policy decisions, execution links, and verification MUST persist independently of an AI conversation.

Restarting a service or coordinator must preserve work identity and allow recovery from recorded state. Repeated events and queue deliveries must not create duplicate changes.

Long-running scans, source work, and remediation MUST expose progress, cancellation, deadlines, and terminal results. Resource limits must be configurable.

### 13.3 APIs and agent tools

The product MUST expose versioned, machine-readable operations for:

- Asset, application, repository, deployment, and capability lookup.
- Assessment and scanner job submission, status, and result ingestion.
- Finding queries, evidence retrieval, applicability, and prioritization.
- Profile assignment and impact assessment.
- Plan preparation, explanation publication, revision, and authorization.
- Campaign execution, progress, pause, and reconciliation.
- Repository change, validation, build, and deployment tracking.
- Verification, exceptions, and export.

The API MUST have an OpenAPI description and typed contracts suitable for HiveXUI and agent integrations. The planning agent chooses endpoint names and transport details.

Agent operations must use the same authoritative rules as other clients. A2A delegation may coordinate work but cannot transfer permissions beyond the delegated scope.

### 13.4 Dependency and outage behavior

Installation MUST check for compatible Magnus services and target capabilities. Unsupported versions and missing capabilities must produce actionable messages.

If Magnus becomes unavailable, existing findings, plans, and evidence remain inspectable, but new managed-host dispatch cannot proceed. Work resumes only after capability and execution-state reconciliation.

An unavailable model blocks new AI analysis that needs it, while inspection, evidence ingestion, and policy-permitted deterministic reconciliation can continue.

The product MUST NOT silently switch to an unmanaged execution path during an outage.

### 13.5 Repository and evidence access

Repository access, write operations, model-provider use, and evidence visibility MUST follow configured scope and existing suite identity rules.

The product must retain evidence sufficient to explain decisions and verify outcomes while redacting secrets from general conversation and logging. It should avoid retaining unnecessary full source copies outside authorized workspaces.

## 14. Operator interaction requirements

The primary interaction consists of a recommended plan, any required decision, progress, exceptions, and an evidenced outcome.

The product MUST allow the operator to:

- Understand why the AI recommends the plan and what will change.
- See whether it is already authorized or awaiting a decision.
- Approve when necessary, reject, narrow scope, or request revision.
- Pause further dispatch and understand in-flight work.
- Review concise results and open supporting evidence or source diffs.
- Ask follow-up questions about remaining risk, coverage, or recurrence.

Routine work covered by standing policy MUST not require repeated manual navigation or approval.

HiveXUI should provide a compact entry point using existing suite patterns. Conversation and notification integrations should reuse available suite surfaces. This specification intentionally leaves screen hierarchy, detailed page design, control placement, and dashboard composition to later interface design.

Machine-readable evidence and reports are required even when a detailed operator interface is absent.

## 15. Outcome reporting

The product MUST report meaningful progress with coverage and scope attached. Required measures include:

- Open and verified-remediated findings by application, environment, owner, and type.
- Exposed findings with known exploitation signals.
- Source fixes awaiting build or deployment.
- Deployed fixes awaiting verification.
- Remediation age, time to verified resolution, and recurrent weaknesses.
- Failed, blocked, and unknown-outcome operations.
- Active and expired exceptions.
- Assessment coverage, unsupported targets, and stale evidence.
- Findings addressed by a common fix or campaign.

Reports MUST distinguish risk acceptance, mitigation, removal, and verified correction. They must not treat all four as the same security outcome.

A concise campaign completion record MUST state what changed, what was verified, which targets remain outstanding, and what intervention is needed.

## 16. End-product acceptance criteria

Acceptance MUST demonstrate real integrated behavior on an isolated reference environment. Synthetic fixtures are appropriate for failure cases and future interfaces, but they cannot substitute for working required scanner, Magnus, repository, and remediation integrations.

The reference environment SHOULD include at least three Magnus-managed Ubuntu hosts for staged execution, an application repository with controlled vulnerable fixtures, an affected and corrected OCI image, and a supported deployment path. Tests must use authorized disposable assets.

| ID | Required demonstration |
| --- | --- |
| AC-01 | Installation identifies Magnus as required, checks compatibility, and reports missing target capabilities. A disconnected Magnus leaves history inspectable and blocks new managed-host dispatch. |
| AC-02 | Inventory reconciles host, application, repository, image, workload, and runtime-instance identities without relying solely on names, IPs, or mutable tags. |
| AC-03 | A versioned Ubuntu hardening profile produces evidence-backed results, an actionable plan, a supported configuration change, fresh verification, and a later detected recurrence. |
| AC-04 | A supported vendor security package update is planned and executed through a bounded Magnus operation, with relevant dependency, restart/reboot, and running-state verification. |
| AC-05 | A supported custom AI scanner actually examines a TypeScript/JavaScript repository and reports evidence-backed code findings beyond dependency advisories. Coverage and unsupported analysis are visible. |
| AC-06 | The scanner workflow demonstrates a candidate finding, a validated defect, a disputed or false-positive result with rationale, and a partial scan that cannot close unexamined findings. |
| AC-07 | Monorepo application boundaries, a repository rename, and findings repeated across scans preserve correct ownership and identity. Distinct defects sharing a classification are not silently merged. |
| AC-08 | Authorized isolated preparation produces an accurate draft and diff before explanation. The AI explains the structured plan before the covered changes in Section 9.2. A plan within standing policy proceeds without acknowledgment; a plan requiring approval waits for an explicit decision. |
| AC-09 | Material changes to targets, source revision, patch, policy, or operational impact trigger reevaluation and cannot inherit stale authorization. |
| AC-10 | A source remediation produces an isolated change and linked pull request, runs relevant validation, and respects required repository checks. Merge and deployment permissions remain separate. |
| AC-11 | A fix verified in source remains outstanding for a deployment still using an affected artifact. A fix on one branch does not close occurrences on another maintained branch. An explicitly source-only application can complete source verification without an invented deployment obligation. |
| AC-12 | A corrected image is traced through a supported build and deployment, and runtime closure requires the actual deployed digest plus appropriate reassessment and service-health evidence. |
| AC-13 | A campaign groups related findings, executes a canary or staged change, honors disruption limits, and stops later dispatch when required validation fails. |
| AC-14 | A successful command followed by failed security verification leaves the finding unresolved. An offline target remains awaiting verification. |
| AC-15 | A lost response or interrupted change retains its original execution identity and is reconciled through Magnus without blind replay or bypass of a held resource. |
| AC-16 | Operator pause stops future dispatch and reports admitted or running actions accurately. Recovery follows its own authorization and verification requirements. |
| AC-17 | Replacing a container creates a new instance while retaining application and image history. Temporary in-container changes do not close a defect still present in the controlling image. |
| AC-18 | Future container-agent contract tests demonstrate scoped enrollment, identity, assessment, and operation routing. A container-scoped target cannot request a host-scoped action. |
| AC-19 | Exceptions preserve ownership, rationale, scope, expiry, and residual risk. Expiration triggers reassessment or renewed work. |
| AC-20 | Secret evidence is redacted in ordinary model context and notifications. Repository content and scanner output cannot broaden worker or repository permissions, and executed repository code cannot access fleet-management or provider-write credentials. |
| AC-21 | Service and coordinator restarts preserve plans, execution links, and verification state. Duplicate events do not create duplicate changes. |
| AC-22 | The operator can follow the required recommendation-to-outcome workflow through a concise suite interaction surface without a detailed manual remediation workbench. |
| AC-23 | The product produces a coherent campaign result showing verified changes, source/runtime distinctions, remaining blockers, exceptions, and assessment coverage. |
| AC-24 | Removing an exposed secret from source leaves credential exposure outstanding until the owning system or authorized owner supplies valid invalidation evidence and any required consumer migration is verified. |

These criteria define the completed product. The planning agent must map implementation work and meaningful validation to them.

## 17. Instructions for the planning agent

Use this specification as the product goal. Inspect the current HiveMagnus repositories and identify reusable contracts and necessary changes before selecting implementation details.

Preserve the binding decisions, AI-led operator workflow, Magnus dependency, repository/application relationships, verification distinctions, and container-agent extension boundary.

The plan MUST include any Magnus capability work necessary for required host operations. Existing diagnostics, restart, rollout, and receipt functionality cannot be assumed to provide complete patch management.

Resolve routine technical choices using the current suite. Concrete schemas, storage indexes, queue selection, API routes, worker packaging, scanner internals, and test organization are planning decisions.

Choose the smallest coherent architecture that satisfies the complete product behavior. Keep product requirements separate from assumptions about existing code.

Do not substitute a static vulnerability dashboard, scanner adapter stub, sample-only application scanner, or a manual-only remediation process for the specified outcomes.

Do not make the future container-agent implementation a hidden prerequisite. Required readiness is the compatible identity, capability, relationship, and execution contracts plus their verification.

Document substantive gaps with a chosen implementation approach. Defer detailed operator interface design while retaining all necessary recommendation, decision, intervention, and evidence interactions.

## 18. Grounding and implementation references

The repository observations below were checked on November 9, 2026. They establish useful starting context; the planning agent must inspect the current revisions before implementation. This specification remains normative if the underlying repositories evolve.

- **Magnus** currently describes Linux host management, a host agent, an API, durable command dispatch, and independently managed Ardent runtime integration. [Magnus README](https://github.com/ChefTaco/magnus/blob/main/README.md)
- **Magnus command resource leases** document admission and ownership behavior, including restrictions on system updates and other operations for enrolled nodes whose completion is not yet supported by that boundary. Required Embermend operations need supported extensions, not an alternate path around those restrictions. [Resource leases](https://github.com/ChefTaco/magnus/blob/main/docs/COMMAND_RESOURCE_LEASES.md)
- **Magnus receipts** distinguish running, unknown, completed, and reconciled execution outcomes. [Command receipts](https://github.com/ChefTaco/magnus/blob/main/docs/COMMAND_RECEIPTS.md)
- **Magnus remediation and rollout code** provides existing runbook and staged-execution foundations to inspect and extend. [Remediation service](https://github.com/ChefTaco/magnus/blob/main/services/control-api/src/services/remediation-service.ts) · [Rollout service](https://github.com/ChefTaco/magnus/blob/main/services/control-api/src/services/rollout-service.ts)
- **Ardent** documents durable tasks, typed tools, management APIs, plugins, A2A support, and a currently read-only Magnus integration. Embermend needs appropriate product tools for its authorized workflows. [Ardent README](https://github.com/ChefTaco/Ardent/blob/main/README.md)
- **HiveXUI** describes the shared browser console and product-owned APIs. [HiveXUI README](https://github.com/ChefTaco/HiveXUI/blob/main/README.md)
- **Cindertrace** owns investigation and response context that Embermend can reference. [Cindertrace README](https://github.com/ChefTaco/cindertrace/blob/main/README.md)
- **Ubuntu OVAL** documents vendor-produced vulnerability and missing-patch assessment data. [Canonical security documentation](https://documentation.ubuntu.com/security/security-updates/oval/)
- **Trivy** explains distribution-aware vulnerability matching and vendor backports. [Vulnerability scanning](https://trivy.dev/docs/latest/scanner/vulnerability/)
- **Wazuh** provides optional configuration and vulnerability assessment sources. [Security Configuration Assessment](https://documentation.wazuh.com/current/user-manual/capabilities/sec-config-assessment/index.html) · [Vulnerability detection](https://documentation.wazuh.com/current/user-manual/capabilities/vulnerability-detection/how-it-works.html)
- **CISA KEV and FIRST EPSS** provide relevant exploitation signals. [Official KEV data](https://github.com/cisagov/kev-data) · [EPSS](https://www.first.org/epss/)
- **CIS content** has product incorporation and certification requirements that must be considered if selected. [CIS product-vendor benchmark certification](https://www.cisecurity.org/cis-securesuite/pricing-and-categories/product-vendor/cis-benchmark-assessment)

The sources describe existing components and assessment inputs. The product requirements, entities, policies, and acceptance criteria above are the proposed Embermend design.
