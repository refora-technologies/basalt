import { useEffect, useRef } from 'react'
import { useReducedMotion } from 'framer-motion'

/**
 * The moving pictures of the tour and of the tips: each shows what a part
 * does, for the many who look rather than read. Drawn as in
 * plans/mockups/1.6.4-whats-new.html, line for line, and lined up with the
 * shapes they sit on (a file lands in the middle of the laptop's screen, the
 * green dot sits under the device, the tap lands on Accept).
 *
 * Plain SVG with its own animation, so nothing in the page drives it. Where
 * the system asks for less motion, each stops on the frame that says it best.
 */

/** The devices and things the pictures share. Drawn once, in a hidden svg. */
const SHAPES = `
<symbol id="ft-phone" viewBox="0 0 40 70"><rect x="2" y="2" width="36" height="66" rx="8" fill="#1C1C1F" stroke="#4A4A52" stroke-width="2"/><rect x="15" y="7" width="10" height="2.5" rx="1.25" fill="#4A4A52"/></symbol>
<symbol id="ft-laptop" viewBox="0 0 110 70"><rect x="14" y="4" width="82" height="52" rx="5" fill="#1C1C1F" stroke="#4A4A52" stroke-width="2"/><path d="M4 60h102l-6 7H10z" fill="#2A2A2F" stroke="#4A4A52" stroke-width="2" stroke-linejoin="round"/></symbol>
<symbol id="ft-file" viewBox="0 0 30 36"><rect x="3" y="1.5" width="24" height="33" rx="5" fill="#F4F4F5"/><rect x="8" y="10" width="14" height="2.6" rx="1.3" fill="#86868D"/><rect x="8" y="15.5" width="9.5" height="2.6" rx="1.3" fill="#B4B4BA"/><rect x="8" y="21" width="12" height="2.6" rx="1.3" fill="#B4B4BA"/></symbol>
<symbol id="ft-note" viewBox="0 0 30 30"><path d="M11 22V6l15-3v16" fill="none" stroke="#F4F4F5" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="7" cy="22" r="4.2" fill="#F4F4F5"/><circle cx="22" cy="19" r="4.2" fill="#F4F4F5"/></symbol>
<g id="ft-beat"><use href="#ft-note" x="-10" y="-10" width="20" height="20"/><animateTransform attributeName="transform" type="translate" additive="sum" values="0 0;0 -12;0 0" dur="0.8s" repeatCount="indefinite" calcMode="spline" keySplines=".3 0 .3 1;.3 0 .3 1"/></g>
`

/** A file goes from the phone to the laptop, lands in its screen, and is ticked. */
const SHARE = `
<use href="#ft-phone" x="20" y="38" width="44" height="77"/>
<use href="#ft-laptop" x="130" y="48" width="104" height="66"/>
<path d="M62 46 C 92 6, 152 6, 182 44" fill="none" stroke="#3A3A40" stroke-width="2" stroke-dasharray="3 5" stroke-linecap="round"/>
<path id="ft-fly" d="M42 78 L 62 46 C 92 6, 152 6, 182 44 L 182 76" fill="none" stroke="none"/>
<g><use href="#ft-file" x="-11" y="-14" width="22" height="27"/>
  <animateMotion dur="3s" repeatCount="indefinite" keyPoints="0;0;1;1" keyTimes="0;0.15;0.6;1" calcMode="spline" keySplines="0 0 1 1;.4 0 .2 1;0 0 1 1"><mpath href="#ft-fly"/></animateMotion>
  <animate attributeName="opacity" values="0;1;1;1;0" keyTimes="0;0.12;0.6;0.92;1" dur="3s" repeatCount="indefinite"/>
</g>
<g opacity="0"><circle cx="192" cy="88" r="5.5" fill="#34D399" stroke="#1C1C1F" stroke-width="2"/>
  <path d="M189.6 88l1.7 1.7 3.2-3.4" fill="none" stroke="#0B0B0C" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
  <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.6;0.66;0.92;1" dur="3s" repeatCount="indefinite"/>
</g>
<circle cx="182" cy="128" r="4" fill="#34D399"><animate attributeName="opacity" values="1;.25;1" dur="1.6s" repeatCount="indefinite"/></circle>
`

/** One phone calls out, the other answers, and the file hops across. */
const NEARBY = `
<use href="#ft-phone" x="30" y="38" width="44" height="77"/>
<use href="#ft-phone" x="176" y="38" width="44" height="77"/>
<g fill="none" stroke="#F4F4F5" stroke-width="2">
  <circle cx="52" cy="76" r="10"><animate attributeName="r" values="10;95" dur="2.4s" repeatCount="indefinite"/><animate attributeName="opacity" values=".5;0" dur="2.4s" repeatCount="indefinite"/></circle>
  <circle cx="52" cy="76" r="10"><animate attributeName="r" values="10;95" dur="2.4s" begin="0.8s" repeatCount="indefinite"/><animate attributeName="opacity" values=".5;0" dur="2.4s" begin="0.8s" repeatCount="indefinite"/></circle>
</g>
<rect x="178.2" y="40.2" width="39.6" height="72.6" rx="8.8" fill="none" stroke="#34D399" stroke-width="2.5" opacity="0">
  <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.35;0.45;0.85;1" dur="2.4s" repeatCount="indefinite"/>
</rect>
<g><use href="#ft-file" x="-9" y="-11" width="18" height="22"/>
  <animateMotion dur="2.4s" repeatCount="indefinite" path="M52 76 L 198 76" keyPoints="0;0;1;1" keyTimes="0;0.45;0.8;1" calcMode="linear"/>
  <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.44;0.48;0.8;0.86" dur="2.4s" repeatCount="indefinite"/>
</g>
`

/** The app goes away; a notification with Accept comes down all the same. */
const BACKGROUND = `
<clipPath id="ft-screen"><rect x="98" y="16" width="54" height="104" rx="9"/></clipPath>
<rect x="96" y="14" width="58" height="108" rx="11" fill="#1C1C1F" stroke="#4A4A52" stroke-width="2"/>
<g clip-path="url(#ft-screen)">
  <g><rect x="98" y="16" width="54" height="104" fill="#26262B"/><rect x="106" y="28" width="38" height="5" rx="2.5" fill="#4A4A52"/><rect x="106" y="40" width="28" height="5" rx="2.5" fill="#3A3A40"/><rect x="106" y="52" width="33" height="5" rx="2.5" fill="#3A3A40"/>
    <animateTransform attributeName="transform" type="translate" values="0 0;0 0;0 110;0 110;0 0" keyTimes="0;0.2;0.35;0.95;1" dur="4s" repeatCount="indefinite"/>
  </g>
</g>
<g><rect x="58" y="-30" width="134" height="30" rx="10" fill="#F4F4F5"/>
  <rect x="68" y="-21" width="60" height="5" rx="2.5" fill="#0B0B0C"/><rect x="68" y="-12" width="40" height="4" rx="2" fill="#86868D"/>
  <rect x="150" y="-23" width="34" height="14" rx="7" fill="#0B0B0C"/><text x="167" y="-13" font-size="7.5" font-weight="700" text-anchor="middle" fill="#F4F4F5" font-family="Plus Jakarta Sans Variable, system-ui">Accept</text>
  <animateTransform attributeName="transform" type="translate" values="0 0;0 0;0 52;0 52;0 0" keyTimes="0;0.45;0.55;0.9;1" dur="4s" repeatCount="indefinite"/>
</g>
<circle cx="125" cy="140" r="4" fill="#34D399"><animate attributeName="opacity" values="1;.25;1" dur="1.6s" repeatCount="indefinite"/></circle>
`

/** The window goes; the tray's dot stays, and a notification comes at the corner. */
const TRAY = `
<use href="#ft-laptop" x="40" y="34" width="170" height="108"/>
<rect x="66" y="44" width="118" height="64" rx="3" fill="#26262B">
  <animate attributeName="opacity" values="1;1;0;0;1" keyTimes="0;0.2;0.32;0.95;1" dur="4s" repeatCount="indefinite"/>
</rect>
<circle cx="181" cy="115" r="3" fill="#34D399"><animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.3;0.34;0.95;1" dur="4s" repeatCount="indefinite"/></circle>
<g opacity="0"><rect x="112" y="73" width="72" height="35" rx="6" fill="#F4F4F5"/>
  <rect x="119" y="80" width="36" height="4" rx="2" fill="#0B0B0C"/><rect x="119" y="88" width="26" height="3.5" rx="1.75" fill="#86868D"/>
  <rect x="149" y="95" width="28" height="8" rx="4" fill="#0B0B0C"/>
  <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.5;0.58;0.9;1" dur="4s" repeatCount="indefinite"/>
</g>
`

/** The same note, in time, on all three. */
const MUSIC = `
<use href="#ft-phone" x="18" y="52" width="40" height="70"/>
<use href="#ft-laptop" x="76" y="62" width="98" height="62"/>
<use href="#ft-phone" x="192" y="52" width="40" height="70"/>
<use href="#ft-beat" x="38" y="36"/><use href="#ft-beat" x="125" y="36"/><use href="#ft-beat" x="212" y="36"/>
<g fill="#34D399">
  <rect x="109" y="94" width="4" height="6" rx="2"><animate attributeName="height" values="6;16;6" dur="0.8s" repeatCount="indefinite"/><animate attributeName="y" values="94;84;94" dur="0.8s" repeatCount="indefinite"/></rect>
  <rect x="116" y="86" width="4" height="14" rx="2"><animate attributeName="height" values="14;5;14" dur="0.8s" repeatCount="indefinite"/><animate attributeName="y" values="86;95;86" dur="0.8s" repeatCount="indefinite"/></rect>
  <rect x="123" y="92" width="4" height="8" rx="2"><animate attributeName="height" values="8;15;8" dur="0.8s" repeatCount="indefinite"/><animate attributeName="y" values="92;85;92" dur="0.8s" repeatCount="indefinite"/></rect>
  <rect x="130" y="88" width="4" height="12" rx="2"><animate attributeName="height" values="12;6;12" dur="0.8s" repeatCount="indefinite"/><animate attributeName="y" values="88;94;88" dur="0.8s" repeatCount="indefinite"/></rect>
  <rect x="137" y="95" width="4" height="5" rx="2"><animate attributeName="height" values="5;14;5" dur="0.8s" repeatCount="indefinite"/><animate attributeName="y" values="95;86;95" dur="0.8s" repeatCount="indefinite"/></rect>
</g>
`

/** The offer on the laptop, Accept tapped there; the phone's own copy fades. */
const ELSEWHERE = `
<use href="#ft-phone" x="4" y="12" width="26" height="46"/>
<g><rect x="7.5" y="27" width="19" height="13" rx="2.2" fill="#26262B"/>
  <rect x="10" y="30" width="3.6" height="4.6" rx=".6" fill="#C9C9CE"/>
  <rect x="15.2" y="30.4" width="9" height="1.6" rx=".8" fill="#F4F4F5"/>
  <rect x="15.2" y="33.4" width="6" height="1.3" rx=".65" fill="#86868D"/>
  <rect x="10" y="36.2" width="8" height="2.2" rx="1.1" fill="#F4F4F5"/>
  <animate attributeName="opacity" values="1;1;.3;.3;1" keyTimes="0;0.5;0.58;0.92;1" dur="3s" repeatCount="indefinite"/>
</g>
<use href="#ft-laptop" x="36" y="10" width="82" height="52"/>
<rect x="50" y="17" width="54" height="29" rx="3" fill="#26262B"/>
<rect x="54" y="20.6" width="6.2" height="8.4" rx="1.3" fill="#F4F4F5"/><rect x="55.4" y="23" width="3.4" height=".9" rx=".45" fill="#86868D"/><rect x="55.4" y="25" width="2.4" height=".9" rx=".45" fill="#B4B4BA"/>
<circle cx="60.4" cy="28.6" r="2.6" fill="#34D399" opacity="0"><animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.5;0.56;0.92;1" dur="3s" repeatCount="indefinite"/></circle>
<path d="M59.2 28.6l.9.9 1.7-1.8" fill="none" stroke="#0B0B0C" stroke-width=".8" stroke-linecap="round" stroke-linejoin="round" opacity="0"><animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.5;0.56;0.92;1" dur="3s" repeatCount="indefinite"/></path>
<rect x="64" y="21.4" width="28" height="2.4" rx="1.2" fill="#F4F4F5"/>
<rect x="64" y="25.8" width="19" height="1.8" rx=".9" fill="#86868D"/>
<rect x="54" y="35.4" width="20" height="6.4" rx="3.2" fill="#F4F4F5"><animate attributeName="fill" values="#F4F4F5;#F4F4F5;#34D399;#34D399;#F4F4F5" keyTimes="0;0.47;0.5;0.92;1" dur="3s" repeatCount="indefinite"/></rect>
<text x="64" y="39.9" font-size="3.6" font-weight="700" text-anchor="middle" fill="#0B0B0C" font-family="Plus Jakarta Sans Variable, system-ui">Accept</text>
<text x="85" y="39.9" font-size="3.6" font-weight="600" text-anchor="middle" fill="#86868D" font-family="Plus Jakarta Sans Variable, system-ui">Decline</text>
<circle cx="64" cy="38.6" r="3" fill="none" stroke="#F4F4F5" stroke-width="1.2" opacity="0">
  <animate attributeName="opacity" values="0;0;.9;0;0" keyTimes="0;0.38;0.45;0.6;1" dur="3s" repeatCount="indefinite"/>
  <animate attributeName="r" values="2;2;3;9;9" keyTimes="0;0.38;0.45;0.6;1" dur="3s" repeatCount="indefinite"/>
</circle>
`

/** The same, the other way: on the computer, taken on the phone. */
const ELSEWHERE_PHONE = `
<use href="#ft-laptop" x="2" y="10" width="82" height="52"/>
<g><rect x="24" y="22" width="38" height="20" rx="2.6" fill="#26262B"/>
  <rect x="28" y="26" width="5" height="6.4" rx=".8" fill="#C9C9CE"/>
  <rect x="35.4" y="26.6" width="16" height="2" rx="1" fill="#F4F4F5"/>
  <rect x="35.4" y="30.2" width="10" height="1.6" rx=".8" fill="#86868D"/>
  <rect x="28" y="35.2" width="12" height="3.2" rx="1.6" fill="#F4F4F5"/>
  <animate attributeName="opacity" values="1;1;.3;.3;1" keyTimes="0;0.5;0.58;0.92;1" dur="3s" repeatCount="indefinite"/>
</g>
<use href="#ft-phone" x="88" y="12" width="26" height="46"/>
<rect x="90.6" y="21" width="20.8" height="28" rx="2.4" fill="#26262B"/>
<rect x="93.2" y="24" width="5" height="6.6" rx="1" fill="#F4F4F5"/><rect x="94.3" y="26.2" width="2.8" height=".8" rx=".4" fill="#86868D"/><rect x="94.3" y="27.9" width="2" height=".8" rx=".4" fill="#B4B4BA"/>
<circle cx="98.2" cy="30.4" r="2.3" fill="#34D399" opacity="0"><animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.5;0.56;0.92;1" dur="3s" repeatCount="indefinite"/></circle>
<path d="M97.1 30.4l.8.8 1.5-1.6" fill="none" stroke="#0B0B0C" stroke-width=".75" stroke-linecap="round" stroke-linejoin="round" opacity="0"><animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.5;0.56;0.92;1" dur="3s" repeatCount="indefinite"/></path>
<rect x="100.6" y="24.6" width="8.4" height="1.8" rx=".9" fill="#F4F4F5"/>
<rect x="100.6" y="27.8" width="5.6" height="1.4" rx=".7" fill="#86868D"/>
<rect x="93.2" y="35.4" width="15.6" height="5.4" rx="2.7" fill="#F4F4F5"><animate attributeName="fill" values="#F4F4F5;#F4F4F5;#34D399;#34D399;#F4F4F5" keyTimes="0;0.47;0.5;0.92;1" dur="3s" repeatCount="indefinite"/></rect>
<text x="101" y="39.25" font-size="3.3" font-weight="700" text-anchor="middle" fill="#0B0B0C" font-family="Plus Jakarta Sans Variable, system-ui">Accept</text>
<text x="101" y="45.4" font-size="3" font-weight="600" text-anchor="middle" fill="#86868D" font-family="Plus Jakarta Sans Variable, system-ui">Decline</text>
<circle cx="101" cy="38.1" r="3" fill="none" stroke="#F4F4F5" stroke-width="1.2" opacity="0">
  <animate attributeName="opacity" values="0;0;.9;0;0" keyTimes="0;0.38;0.45;0.6;1" dur="3s" repeatCount="indefinite"/>
  <animate attributeName="r" values="2;2;3;9;9" keyTimes="0;0.38;0.45;0.6;1" dur="3s" repeatCount="indefinite"/>
</circle>
`

/** The code on the one is typed on the other, and it is ticked. */
const CODE = `
<use href="#ft-phone" x="6" y="6" width="28" height="50"/>
<use href="#ft-phone" x="62" y="6" width="28" height="50"/>
<g font-family="Geist Mono Variable, monospace" font-size="7" font-weight="700" fill="#F4F4F5" text-anchor="middle">
  <text x="20" y="27">482</text><text x="20" y="36">913</text>
  <text x="76" y="27">482</text>
  <text x="76" y="36" opacity="0">913<animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.4;0.55;0.9;1" dur="2.6s" repeatCount="indefinite"/></text>
</g>
<path d="M71 45 l3 3 6-6" fill="none" stroke="#34D399" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" opacity="0"><animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.58;0.64;0.9;1" dur="2.6s" repeatCount="indefinite"/></path>
`

export type ArtName = 'share' | 'nearby' | 'background' | 'tray' | 'music' | 'elsewhere' | 'elsewherePhone' | 'code'

const ART: Record<ArtName, { body: string; viewBox: string; width: number; height: number; still: number }> = {
  share: { body: SHARE, viewBox: '0 0 250 150', width: 250, height: 150, still: 2.4 },
  nearby: { body: NEARBY, viewBox: '0 0 250 150', width: 250, height: 150, still: 1.6 },
  background: { body: BACKGROUND, viewBox: '0 0 250 150', width: 250, height: 150, still: 2.8 },
  tray: { body: TRAY, viewBox: '0 0 250 150', width: 250, height: 150, still: 2.8 },
  music: { body: MUSIC, viewBox: '0 0 250 150', width: 250, height: 150, still: 0.4 },
  elsewhere: { body: ELSEWHERE, viewBox: '0 0 120 72', width: 132, height: 80, still: 2 },
  elsewherePhone: { body: ELSEWHERE_PHONE, viewBox: '0 0 120 72', width: 132, height: 80, still: 2 },
  code: { body: CODE, viewBox: '0 0 96 64', width: 96, height: 64, still: 2 },
}

/**
 * The shapes the pictures use: once in the app, below everything (two copies
 * would give the same names twice). The music's beat moves here, so here is
 * where it stops too.
 */
export function TourShapes(): React.JSX.Element {
  const svg = useRef<SVGSVGElement>(null)
  const still = useReducedMotion()
  useEffect(() => {
    if (still) svg.current?.pauseAnimations()
  }, [still])
  return (
    <svg
      ref={svg}
      aria-hidden
      width="0"
      height="0"
      className="pointer-events-none absolute"
      dangerouslySetInnerHTML={{ __html: `<defs>${SHAPES}</defs>` }}
    />
  )
}

export function TourArt({ name, className, scale = 1 }: { name: ArtName; className?: string; scale?: number }): React.JSX.Element {
  const art = ART[name]
  const svg = useRef<SVGSVGElement>(null)
  const still = useReducedMotion()
  useEffect(() => {
    const el = svg.current
    if (!el || !still) return
    // The frame that says it best, and no further.
    el.setCurrentTime(art.still)
    el.pauseAnimations()
  }, [still, art.still])
  return (
    <svg
      ref={svg}
      aria-hidden
      viewBox={art.viewBox}
      width={art.width * scale}
      height={art.height * scale}
      className={className}
      dangerouslySetInnerHTML={{ __html: art.body }}
    />
  )
}
