/**
 * Las consultas de plantillas se movieron a `@crmapp/envio` con la puerta de
 * envío (la usan la API y el worker). Aquí queda la reexportación para que el
 * módulo de plantillas siga importando de donde importaba.
 */
export {
  exigirPlantillaAprobada,
  plantillasAprobadas,
  versionActualDeRapida,
  type PlantillaSugerida,
  type VersionDeRapida,
} from '@crmapp/envio';
