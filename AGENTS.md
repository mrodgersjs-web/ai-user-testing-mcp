
## RIG lattice contract (stamped)

This repository runs the shared RIG lattice: loops in `.rig/loop.yaml`, pre-tool
hooks in `.rig/hooks/`, CI gate in `.github/workflows/rig-lattice.yml`. D85 rules
apply: every outward action needs a Gate-D request + typed approval; durable
builds need four ratios >= 0.85 and a sealed proof. Shared agent substrate lives
in Supabase schema `rig_shared` (see PROGRAM.md in rig-lattice-retrofit).
