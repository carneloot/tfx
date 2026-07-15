#!/usr/bin/env node

const approval = process.env.TFX_APPROVE_PHOTON_PUBLICATION
if (approval !== "I_ACCEPT_PHOTON_DERIVED_PUBLICATION") {
  console.error([
    "Refusing to publish tfx: generated Telegram artifacts derive from the pinned Photon OpenAPI source.",
    "Review source licensing and publication approval, then set:",
    "TFX_APPROVE_PHOTON_PUBLICATION=I_ACCEPT_PHOTON_DERIVED_PUBLICATION"
  ].join("\n"))
  process.exit(1)
}
