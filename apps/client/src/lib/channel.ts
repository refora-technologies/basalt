/// <reference types="vite/client" />

/**
 * Where this copy of Basalt came from, decided when it is built.
 *
 * The Google Play build is made with `VITE_BASALT_CHANNEL=play`. Play updates
 * it, and an app from Play may not update itself: in that build the GitHub
 * update check, its banner, its notification and its installer are all off.
 * Every other build (GitHub, the website, the Windows installers) keeps them.
 */
export const PLAY_STORE = import.meta.env.VITE_BASALT_CHANNEL === 'play'
