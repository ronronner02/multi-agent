# Delivery lead evidence after integration

Delivery lead evidence covers one management turn: a proposal, an escalation, or no file change. An integration commit made after the lead's candidate was created must never appear as a deletion by the lead.

Before each delivery lead dispatch, recreate its candidate from the current integration head and clear the native resume token for the replaced tree. This also removes the previous turn's management files, which have already been consumed at turn end. Keep the candidate's starting base in the existing control-owned candidate record directory so a restart during the turn cannot substitute a later integration head.

This uses the existing candidate creation, provenance and evidence readers. Planning turns and implementer/reviewer candidates keep their existing continuation behavior. No public contract or database migration changes.

Merge readiness and the merge action refuse a pending, in-progress or blocked lead task. A completed management turn closes that row; a lead that still has work must finish before the owner can merge.
