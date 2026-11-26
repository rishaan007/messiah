import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "MESSIAH — The Universal AI Agent Workspace",
    short_name: "MESSIAH",
    description: "One intelligence layer. Every agent. Every device.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#090A0F",
    theme_color: "#090A0F",
    categories: ["developer", "productivity", "utilities"],
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/messiah-mark.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
    shortcuts: [
      {
        name: "Approval Queue",
        short_name: "Approvals",
        description: "Review pending tool, bridge, swarm, and workflow approvals",
        url: "/approvals",
      },
      {
        name: "Universal Chat",
        short_name: "Chat",
        description: "Continue AI conversations across devices",
        url: "/chat",
      },
      {
        name: "Swarm Topology",
        short_name: "Swarms",
        description: "Monitor active multi-agent constellations",
        url: "/swarms",
      },
      {
        name: "Workflows",
        short_name: "Workflows",
        description: "Inspect DAG automations and schedules",
        url: "/workflows",
      },
    ],
  };
}
