# Managed reboot and immutable Compose rollout

These are opt-in Magnus capabilities for reviewed Ubuntu 24.04 hosts. Embermend
owns recommendations, authorization and verification; Magnus owns admission,
native execution, ownership and receipts. An unsupported capability is a blocker.
No SSH or arbitrary-shell execution fallback is provided.

## Protected node policy

A fresh disposable host can configure this policy before enrollment. Existing
hosts require a separately reviewed configuration/upgrade admission; do not bypass
their existing enrollment or mutation barriers to change capability settings.
The node policy is a root-owned private regular file, with no generated commands:

```json
{
  "version": 1,
  "resources": {
    "example-deployment": {
      "kind": "compose",
      "path": "/opt/example/compose.yaml",
      "overridePath": "/opt/example/image.yaml",
      "service": "web",
      "imageRepository": "registry.example.com/example/app",
      "healthUrl": "https://app.example.com/health"
    }
  },
  "securityPackages": [],
  "reboot": {
    "managementProbeId": "reviewed-management-path",
    "continuationWindowSeconds": 300
  }
}
```

The enrolled agent must have privileged mode and its execution supervisor enabled.
The constrained service grant must explicitly permit each target and action.
Absence of the `reboot` policy leaves reboot unadvertised. Compose inventory and
rollout require the allowlisted configuration and service, not repository commands.

## Reboot continuation

1. Obtain fresh managed inventory, including the kernel `bootId`. Prepare an exact
   `reboot.v1` action with `beforeBootId`, the reviewed `managementProbeId`, reboot
   impact, a bounded window and separate operational verification.
2. Publish the plan revision to the primary recommendation timeline. Obtain an
   explicit decision or matching standing policy before requesting execution.
3. The native handler retains its original identity, schedules one reboot a minute
   ahead and durably records systemd's exact acknowledgement. Acceptance remains
   pending and ownership stays held. Losing contact is not completion.
4. After restart, observation checks the original request/configuration binding,
   acknowledged schedule, different kernel boot and bounded boot time. Missing
   acknowledgement, same-boot restart, changed identity, ambiguous clocks and
   early/late boots stay unknown. Observation never schedules another reboot.
5. If the original campaign job became unknown, an operator with read, evidence
   and recovery access can request `/api/v1/jobs/{id}/reconcile`. The separate
   observation job has its own deadline. It cannot renew the old authorization,
   clear cancellation, resume a campaign or start a missing action.
6. Independently assess current inventory, activation requirements and consumer
   health. Reboot completion alone does not verify a security update or fix.

The acknowledgement reader follows the Ubuntu systemd schedule representation;
see the [systemd 255 implementation](https://github.com/systemd/systemd/blob/v255/src/login/logind-dbus.c).
The complete cancelled-schedule and native-crash matrix remains an acceptance
requirement, beyond the retained normal reboot/deadline continuation proof.

## Immutable artifact rollout

1. Register the application, immutable source revision, artifact and deployment in
   their authorized scopes. The deployment ID matches the reviewed node resource
   key and includes the actual configuration digest and target identity.
2. An authorized reviewer/integration records non-model build evidence binding
   the artifact digest, image reference and source commit. The artifact must be
   established and digest-qualified. The coordinator cannot validate its own
   build evidence. Manually reviewed local build evidence is supported; the full
   hosted and isolated build/publication lifecycle remains pending.
3. Prepare and publish `compose-deploy.v1` with the exact artifact digest,
   configuration digest and current override digest. Deployment permission and
   separate plan approval are required. A source-writing approval cannot deploy.
4. Magnus changes only the allowlisted service, using an immutable image and
   bounded `--no-build --no-deps` Compose execution. It checks actual image and
   running state. An execution receipt still leaves security verification open.
5. A separate managed inventory reconciles the current container instance,
   artifact, host and host-managing agent. Earlier instances remain historical;
   old native capture times cannot overwrite the current deployment, even through a fresh delivery envelope. Repeated inventory retains stable relationships and appends corroborating evidence. Unknown images and
   unavailable resources remain partial/not assessed, never clean by omission.
6. Run independent application-specific security and consumer-health checks.
   Record the exact deployed digest in verification evidence. Runtime resolution
   and source remediation remain distinct. No container agent is implemented.

Restoring a previous artifact or configuration requires a separate exact plan and
its applicable permission/decision. Restoring a configuration file does not by
itself activate the previous artifact or establish recovered application health.

The [retained disposable evidence](acceptance/2026-11-10-reboot-artifact.json)
records one reboot and one rollout, independent consumer checks, historical
instance preservation and a PostgreSQL-only restore. It establishes no production
policy, signed suite release, combined restore or complete acceptance matrix.

The separate [package activation evidence](acceptance/2026-11-10-package-activation.json)
adds an existing-authentication browser approval/pause/resume/start journey and
independent running-state verification after reboot. The installed update left
seven stale userspace ELF mappings beforehand. The fresh post-boot inventory,
vendor assessment and healthy consumer supported technical review of that one
configured package. Other activation classes, namespace/file-view attribution
and the complete reboot fault matrix remain unaccepted.
