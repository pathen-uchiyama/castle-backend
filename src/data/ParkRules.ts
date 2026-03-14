import { ParkRule } from '../models/types';

export const PARK_RULES: Record<string, ParkRule> = {
    'WDW': {
        resort_id: 'WDW',
        dining_window_days: 60,
        ll_booking_window_resort: 7,
        ll_booking_window_other: 3,
        has_tiers: true,
        transport_buffer_mins: 45, // Buses, Monorails, Skyliners take time
        virtual_queue_times: ['07:00', '13:00']
    },
    'DL': {
        resort_id: 'DL',
        dining_window_days: 60,
        ll_booking_window_resort: 0, // Day-of for most
        ll_booking_window_other: 0,
        has_tiers: false,
        transport_buffer_mins: 5, // 5-minute walk between gates
        virtual_queue_times: ['07:00', '12:00']
    }
};
