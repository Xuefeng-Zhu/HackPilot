import { useSetPageTitle } from "@agent-native/toolkit/app-shell/header-actions";

import { HackathonList } from "@/components/hackpilot/HackathonList";

export function meta() {
  return [
    { title: "HackPilot — paste a hackathon, get a plan to win it" },
    {
      name: "description",
      content:
        "Turn any hackathon URL into a rubric-scored idea board, a day-by-day sprint plan, and a submission checklist that you and your agent edit together.",
    },
  ];
}

export default function HackathonsIndexRoute() {
  useSetPageTitle("Hackathons");
  return <HackathonList />;
}
