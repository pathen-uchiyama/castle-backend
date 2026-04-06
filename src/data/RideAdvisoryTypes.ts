/**
 * RideAdvisoryTypes.ts — Shared types for ride advisory system
 */

import { ParkID } from '../models/types';

export type MotionSicknessRisk = 'none' | 'mild' | 'moderate' | 'intense';
export type SpinIntensity = 'none' | 'mild' | 'moderate' | 'intense';
export type HeightDrop = 'none' | 'small' | 'large';
export type WaterExposure = 'dry' | 'may_get_sprayed' | 'will_get_soaked';
export type MotionRoughness = 'smooth' | 'moderate' | 'rough';
export type NoiseLevel = 'quiet' | 'moderate' | 'loud';
export type WheelchairAccess = 'stay_in_chair' | 'must_transfer' | 'must_transfer_from_ecv';
export type RestraintType = 'none' | 'lap_bar' | 'seat_belt' | 'over_shoulder';
export type OperationalStatus = 'open' | 'temporary_closure' | 'refurbishment' | 'seasonal_closure' | 'permanent_closure' | 'under_construction';

export interface RideAdvisory {
  attractionId: string;
  name: string;
  parkId: ParkID;
  land: string;
  heightRequirementInches: number | null;

  // ─── Operational Status ───
  operationalStatus: OperationalStatus;
  reopenDate: string | null;
  reopenDateConfirmed: boolean;
  closureNotes: string | null;
  permanentClosureDate: string | null;
  isNewAttraction: boolean;
  expectedOpenDate: string | null;
  expectedOpenDateConfirmed: boolean;

  // ─── Physical / Sensory ───
  motionSicknessRisk: MotionSicknessRisk;
  has3DGlasses: boolean;
  hasStrobeEffects: boolean;
  hasDarkEnclosed: boolean;
  noiseLevel: NoiseLevel;
  spinIntensity: SpinIntensity;
  heightDrop: HeightDrop;
  waterExposure: WaterExposure;
  motionRoughness: MotionRoughness;

  // ─── Accessibility ───
  wheelchairAccess: WheelchairAccess;
  restraintType: RestraintType;
  serviceAnimalPermitted: boolean;
  expectantMothersAdvised: boolean;
  backNeckAdvisory: boolean;

  // ─── Practical ───
  lockersRequired: boolean;
  lockersRecommended: boolean;
  singleRiderAvailable: boolean;
  riderSwapAvailable: boolean;
  photoPassMoment: boolean;

  advisoryNotes: string[];
}

/** Default operational status for currently-open rides */
export const OPEN_STATUS = {
  operationalStatus: 'open' as OperationalStatus,
  reopenDate: null,
  reopenDateConfirmed: false,
  closureNotes: null,
  permanentClosureDate: null,
  isNewAttraction: false,
  expectedOpenDate: null,
  expectedOpenDateConfirmed: false,
};
