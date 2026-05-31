import { Caido } from "@caido/sdk-frontend";
import { Spec } from "backend";

export type FrontendSDK = Caido<Spec["api"], Spec["events"]>;
