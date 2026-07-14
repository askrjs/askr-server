import {
  defineDynamicRouterScaleBench,
  defineRouterScaleBench,
  defineWildcardRouterScaleBench,
} from "../router-scale";

defineRouterScaleBench("tier1", 8);
defineDynamicRouterScaleBench("tier1", 8);
defineWildcardRouterScaleBench("tier1", 8);
