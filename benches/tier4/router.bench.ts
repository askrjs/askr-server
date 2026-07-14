import {
  defineDynamicRouterScaleBench,
  defineRouterScaleBench,
  defineWildcardRouterScaleBench,
} from "../router-scale";

defineRouterScaleBench("tier4", 1024);
defineDynamicRouterScaleBench("tier4", 1024);
defineWildcardRouterScaleBench("tier4", 1024);
