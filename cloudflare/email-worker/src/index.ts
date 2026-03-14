export interface Env {
    // Environment variables
    API_URL: string;    // e.g., https://api.castlecompanion.com
    API_KEY: string;    // Shared secret for backend auth
}

interface ForwardableEmailMessage {
    from: string;
    to: string;
    headers: Headers;
    raw: ReadableStream;
    rawSize: number;
    setReject(reason: string): void;
    forward(rcptTo: string, headers?: Headers): Promise<void>;
}

export default {
    async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
        console.log(`[EmailWorker] Received email for ${message.to} from ${message.from}`);

        // Only process emails from Disney
        if (!message.from.toLowerCase().includes('disney')) {
            console.log(`[EmailWorker] Ignored non-Disney sender: ${message.from}`);
            return;
        }

        try {
            // Read stream into text using Response API
            const rawEmail = await new Response(message.raw as any).text();

            // Extract the 6-digit code.
            // Disney codes are typically 6-digits, often presented prominently.
            const codeBoundaryRegex = /\b(\d{6})\b/g;
            const matches = [...rawEmail.matchAll(codeBoundaryRegex)];

            // Look for the code. The raw email contains headers, html, and text.
            let foundCode: string | null = null;
            if (matches && matches.length > 0) {
                // Return the first valid 6-digit code found
                foundCode = matches[0][1];
            }

            if (!foundCode) {
                console.warn(`[EmailWorker] Could not find a 6-digit code in the email for ${message.to}`);
                return;
            }

            console.log(`[EmailWorker] Extracted code ${foundCode} for ${message.to}`);

            // Send to our backend webhook
            const url = `${env.API_URL}/api/verify-account`;
            console.log(`[EmailWorker] Submitting to ${url}`);

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${env.API_KEY}`,
                },
                body: JSON.stringify({
                    email: message.to,
                    code: foundCode
                })
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Backend returned ${response.status}: ${errText}`);
            }

            console.log(`[EmailWorker] Successfully forwarded code for ${message.to} to backend.`);
        } catch (error) {
            console.error(`[EmailWorker] Unhandled error processing email:`, error);
            // Optionally, we could forward the email to an admin address if parsing fails
            // await message.forward('admin@castlecompanion.com');
        }
    }
};
