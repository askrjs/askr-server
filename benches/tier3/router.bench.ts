import {
  defineDynamicRouterScaleBench,
  defineRouterScaleBench,
  defineWildcardRouterScaleBench,
} from "../router-scale";

defineRouterScaleBench("tier3", 256);
defineDynamicRouterScaleBench("tier3", 256);
defineWildcardRouterScaleBench("tier3", 256);
