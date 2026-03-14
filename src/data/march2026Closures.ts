import { ParkClosure } from '../models/types';

/**
 * March 2026 Disney Park Closures & Seasonal Events
 *
 * This seed data is loaded into the ParkStatusRegistry at startup.
 * In production, this will be replaced by the Scraper Pipeline (Phase 5B)
 * that automatically ingests closure data from Disney's official feeds.
 */
export const MARCH_2026_CLOSURES: ParkClosure[] = [
    // ── Walt Disney World ───────────────────────────────────────────

    {
        attractionId: 'HS_RNR',
        name: "Rock 'n' Roller Coaster",
        parkId: 'HS',
        closureType: 'refurbishment',
        closureStart: '2025-10-01',
        closureEnd: '2027-06-01',
        reason: 'Ride is being reimagined with The Muppets theme.',
        alternativeNames: ['Slinky Dog Dash', 'Tower of Terror', "Mickey & Minnie's Runaway Railway"]
    },
    {
        attractionId: 'AK_DINO',
        name: 'DINOSAUR',
        parkId: 'AK',
        closureType: 'permanent',
        closureStart: '2026-01-15',
        reason: 'Permanently closed. Being rebuilt as Indiana Jones Adventure.',
        alternativeNames: ['Kilimanjaro Safaris', 'Expedition Everest', 'Kali River Rapids']
    },
    {
        attractionId: 'MK_BTM',
        name: 'Big Thunder Mountain Railroad',
        parkId: 'MK',
        closureType: 'refurbishment',
        closureStart: '2026-01-06',
        closureEnd: '2026-05-15',
        reason: 'Track refurbishment and structural maintenance.',
        alternativeNames: ['Space Mountain', 'Splash Mountain', 'Seven Dwarfs Mine Train']
    },
    {
        attractionId: 'MK_BUZZ',
        name: "Buzz Lightyear's Space Ranger Spin",
        parkId: 'MK',
        closureType: 'refurbishment',
        closureStart: '2026-02-01',
        closureEnd: '2026-06-01',
        reason: 'Digital upgrade to interactive targeting system.',
        alternativeNames: ['Tomorrowland Speedway', 'Astro Orbiter', 'Carousel of Progress']
    },

    // ── Disneyland Resort ────────────────────────────────────────────

    {
        attractionId: 'DL_JUNGLE',
        name: 'Jungle Cruise',
        parkId: 'DL',
        closureType: 'refurbishment',
        closureStart: '2026-01-15',
        closureEnd: '2026-04-01',
        reason: 'Seasonal queue and scene refurbishment.',
        alternativeNames: ['Pirates of the Caribbean', 'Haunted Mansion', 'Indiana Jones Adventure']
    },
    {
        attractionId: 'DL_MONO',
        name: 'Disneyland Monorail',
        parkId: 'DL',
        closureType: 'temporary',
        closureStart: '2026-03-15',
        closureEnd: '2026-03-30',
        reason: 'Track maintenance and beam inspection.',
        alternativeNames: ['Bus Transportation', 'Walking Path via Downtown Disney']
    },
];

/**
 * Seasonal Events active in March 2026
 * These are injected into the RAG layer as context for recommendations.
 */
export const MARCH_2026_EVENTS = [
    {
        id: 'EP_FG2026',
        name: 'EPCOT International Flower & Garden Festival',
        parkId: 'EP',
        startDate: '2026-03-04',
        endDate: '2026-06-01',
        highlights: [
            'Outdoor Kitchen food booths',
            'Garden Rocks Concert Series (Fri-Mon)',
            'Character Topiaries throughout World Showcase',
            'Spike the Bee Scavenger Hunt'
        ]
    },
    {
        id: 'AK_BLUEY',
        name: 'Bluey & Bingo Character Meet',
        parkId: 'AK',
        startDate: '2026-03-22',
        endDate: 'Ongoing',
        highlights: [
            'Character meet location: Discovery Island',
            'Expected 40-60 minute wait during first week',
            'Best times: First hour of park opening or last hour before close'
        ]
    },
    {
        id: 'DST_2026',
        name: 'Daylight Saving Time Shift',
        parkId: 'MK',
        startDate: '2026-03-08',
        highlights: [
            'Clocks spring forward 1 hour',
            'Happily Ever After moved to 9:30 PM (was 9:00 PM)',
            'Sunset now ~45 minutes later — adjust evening routing',
            'Extended Evening Hours adjusted accordingly'
        ]
    }
];
