import { useParams } from "react-router";

import { Workspace } from "@/components/hackpilot/Workspace";

export function meta() {
  return [{ title: "HackPilot — workspace" }];
}

export default function HackathonRoute() {
  const { hackathonId = "" } = useParams();
  return <Workspace key={hackathonId} id={hackathonId} />;
}
