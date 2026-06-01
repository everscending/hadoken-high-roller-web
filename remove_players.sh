#!/bin/bash

remote=""

# Parse all arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --remote)
            remote="--remote"
            shift # Move past the flag
            ;;
        *)
            shift # Move past unknown arguments
            ;;
    esac
done

pnpx wrangler d1 execute hadoken-high-roller --command "delete from spins" $remote
pnpx wrangler d1 execute hadoken-high-roller --command "delete from games" $remote
pnpx wrangler d1 execute hadoken-high-roller --command "delete from auth_tokens" $remote
pnpx wrangler d1 execute hadoken-high-roller --command "delete from players where player_id > 1" $remote


