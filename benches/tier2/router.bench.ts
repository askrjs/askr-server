import {
  defineDynamicRouterScaleBench,
  defineRouterScaleBench,
  defineWildcardRouterScaleBench,
} from "../router-scale";

defineRouterScaleBench("tier2", 64);
defineDynamicRouterScaleBench("tier2", 64);
defineWildcardRouterScaleBench("tier2", 64);
