# NEON COAST

An original open‑world sandbox in the spirit of the GTA series, built from scratch with **Three.js** (3D rendering) and **Rapier** (physics).
Everything (city, cars, people, textures, sounds, music) is generated procedurally in code. There are no external assets.

> یک بازی جهان‌باز سه‌بعدی و اورجینال با الهام از سری GTA. همه چیز (شهر، ماشین‌ها، آدم‌ها، تکسچرها، صداها و موسیقی) به‌صورت پروسیجرال با کد ساخته شده است.

## ▶ How to play on Windows · اجرا در ویندوز

1. Download the repository (green **Code** button → **Download ZIP**) and extract it.
2. Double‑click **`Play.bat`**. It opens the game in its own Chrome/Edge window.
   You can also just double‑click **`dist/NeonCoast.html`**.
3. Click **Play**. The mouse is captured for camera control; press **Esc** to pause.

۱. مخزن را دانلود و از حالت فشرده خارج کنید. ۲. روی **`Play.bat`** دوبار کلیک کنید (یا مستقیم فایل **`dist/NeonCoast.html`** را باز کنید). ۳. روی **Play** بزنید. برای توقف **Esc** را بزنید.

No installation is needed: the game is one self‑contained 5.5 MB HTML file and runs offline.
It needs a GPU with WebGL2 support, which any PC from the last ten years has. For the best result use Chrome or Edge.
On slower machines the game lowers its graphics quality automatically. You can also change it with `F2`.

## 🎮 Controls · کنترل‌ها

| On foot · پیاده | |
|---|---|
| `W A S D` | Move relative to the camera · حرکت |
| `Shift` | Sprint · دویدن سریع |
| `C` | Toggle walk / jog · راه رفتن / دویدن |
| `Space` | Jump · پرش |
| Mouse / `Q` | Look around / punch (left click) · نگاه / مشت |
| `F` | Enter or hijack a car or motorbike; pick up a fallen bike · سوار شدن / دزدیدن ماشین و موتور |

| Weapons · اسلحه (free, unlimited ammo · رایگان، تیر نامحدود) | |
|---|---|
| `1`–`5` / mouse wheel | Fists · pistol · SMG · shotgun · assault rifle |
| Right mouse | Aim · نشانه‌گیری |
| Left mouse | Shoot (from the hip, or aimed) · شلیک |
| Right + left mouse in a vehicle | Drive-by out of the window or off the bike · شلیک از ماشین و موتور |

| Driving · رانندگی | |
|---|---|
| `W` / `S` | Throttle / brake, then reverse · گاز / ترمز و دنده عقب |
| `A` / `D` | Steer · فرمان |
| `Space` | Handbrake (drift) · ترمز دستی (دریفت) |
| `F` | Get out (at speed you jump out and tumble) · پیاده شدن |
| `H` `V` `L` `R` | Horn · look back · headlights · flip car upright |
| `G` | Siren (in a police car) · آژیر ماشین پلیس |
| `Shift` | Motorbike: wheelie (with throttle) · موتور: تک‌چرخ |
| `N` / `M` | Time of day (golden hour / noon / night) · radio |
| `K` | Weather: clear / rain / storm · آب‌وهوا |
| `F2` / `P` | Graphics quality · FPS counter |

Xbox and other standard gamepads also work: LS to move/steer, RT for gas, LT to brake, RB/A for the handbrake, Y to enter or exit, X to jump (wheelie on a bike), B to punch. On foot: LT aims, RT shoots, LB/RB switch weapons.

## ✨ Features · ویژگی‌ها

**Getting into a car (fully animated, no teleporting).**
The character walks around the car to the driver's door and turns to face the handle.
They grab the handle and swing the door open while stepping back, then step into the gap.
If there is a driver, they reach in, drag the driver out (arms flailing) and throw them to the street as a physics ragdoll.
They duck under the roof, put the inner leg in first, sit, bring the other leg in, and pull the door shut by its inner handle. The car dips on its springs as they sit and when the door slams.
While driving, the hands hold the steering wheel and follow it as it turns, and the right foot moves between the throttle and brake pedals.
Getting out reverses all of this: open the door, swing one leg out, stand, and push the door closed.
If the driver's door is blocked by a wall or another car, the character uses the passenger door and slides across the seats; nobody clips through geometry.
At speed, pressing F makes you bail out and tumble across the road.

**Car physics**
- Suspension with springs, separate bump and rebound damping, bump stops and anti‑roll bars. Each wheel is tested as a tyre-shaped volume (not a single ray), so tyres roll up curbs and over obstacles where the rubber actually touches. Bodies visibly roll, pitch and bounce.
- Tyre model based on slip angle, with a peak and then fall‑off. A friction circle means throttle reduces sideways grip (power oversteer). Cars grip well on throttle alone; pull the handbrake and they switch to full drift mode, which fades out over a second or so after you let go, so a handbrake slide can be held on the throttle.
- Engine torque curve, automatic 6‑speed gearbox, rev limiter, clutch slip at launch, drag and downforce.
- Grip depends on the surface: asphalt, concrete, grass, sand.
- Crash damage: the body panels dent where they were hit, glass cracks, lights break, doors can pop open. Damage depends on how hard a crash is, not on how many parts touched, so it takes several heavy crashes before an engine starts to smoke (below 30%), loses power and finally burns.
- Wrecked cars catch fire and explode about 10 s later; a car left on its roof first smokes, then burns. The blast throws nearby cars, props and people.
- An open door swings on its own as the car accelerates and brakes, and slams shut in the airflow.
- Effects: tyre smoke, skid marks, sparks, glass shards.

**Motorcycles** (sport bike and cruiser, in traffic and parked; the red sport bike next to the spawn is yours)
- A real two-wheeler simulation, not a car with two wheels: round tyre profiles, a raked fork, a swingarm, and a rider who balances the bike. It leans into turns by exactly the angle the cornering force needs, so the lean you see is the physics.
- Steering is limited to what the tyres can hold. The fork self-steers into a slide like a real castor, so hard braking doesn't spin it. Load transfer limits wheelies and stoppies; `Shift` pops a controlled wheelie.
- The rider puts a foot down at a stop, tucks behind the screen at speed and hangs off in corners. Parked bikes lean on their kickstand.
- Fully animated: walk to the bike, grab the bars, swing a leg over and sit down, with a helmet that goes on. Getting off reverses it and puts the bike on its stand. You can pull a rider off his bike. A fallen bike is lifted back up with a squat and lift.
- Crashes: hit something hard, land a jump badly, slide out or get shot, and the rider is thrown off as a ragdoll at the speed he was going. The bike tumbles and lies on its side.

**Weapons**
- Pistol, SMG, shotgun and assault rifle, all free with unlimited ammo. Guns are held with two-handed IK: the stock sits in the shoulder and the support hand is on the foregrip. You get recoil, muzzle flash, ejected shells, tracers and bullet holes.
- Bullets follow the crosshair and hit what's actually in the way: people (headshots count), ragdolls, props, glass, and tyres, which burst. They go through car doors at reduced damage. Drive-bys work from cars and bikes.

**Rain and storms** (`K`, or it changes by itself)
- Rain streaks, darker clouds and dimmer sun. Roads get wet and reflective, with puddles and rain ripples. Thunderstorms add lightning and thunder.
- Wet roads have less grip for cars and bikes, so brake earlier. Pedestrians open umbrellas.

**Characters**
- A procedurally modelled, skinned human with smooth joints, a face (eyes, brows, nose, ears, mouth), hair styles and clothing. Pedestrians get random body types, skin tones, outfits, hairstyles, glasses and caps.
- Locomotion is fully procedural and uses inverse kinematics (IK) to plant each foot on the ground, so feet don't slide. Cadence and stance/flight timing follow measured human gait data (walk ~116 steps/min, run ~178, sprint ~196). Both legs are phase-locked so they can never fall out of step. When running, the heel kicks up behind, the knee drives through, and there is a real flight phase. Also: heel strike and toe‑off roll, pelvis bob/sway/twist, counter‑swinging arms, leaning into speed and turns, small steps when turning on the spot, and stepping up and down curbs.
- Walking or running into a parked car just stops you (you never get knocked down by a car that isn't moving). Loose props get shoved with realistic momentum.
- Full‑body ragdolls with anatomical joint limits, for people hit by cars, punched, thrown out of cars, caught in explosions or falling. Ragdolls collide with each other, with cars and with the world. Afterwards they get up with a real get‑up sequence, from either lying on their back or face down.
- Sprinting into someone knocks them over. Pedestrians you punch either run away or fight back.

**Police and wanted level ★★★★★**
- Crimes seen by a police officer give you a wanted level: assault, car theft, running people over. Serious crimes are always reported: murder, attacking or killing an officer, stealing a police car, explosions.
- ★: officers try to arrest you; stand still near one and you're **BUSTED**. ★★ and up: they shoot (only a few at a time, with limited accuracy). ★★★ and up: patrol cars ram you.
- The response is capped: at most one car per star (5 at ★★★★★), and never more than 2–4 officers shooting at once. Your health slowly regenerates when you avoid being hit.
- Police drive with sirens, ignore red lights, overtake traffic through the opposite lane, follow your exact route around corners, and do handbrake turns when they're facing the wrong way. When you stop, they get out and chase on foot. When you drive off, they jump back into their car.
- ★★★ and up: **roadblocks** a block or two ahead of you: patrol cars parked across the street, officers behind them shooting, and spike strips that burst every tyre that rolls over them (cars and bikes). You can try the sidewalk.
- ★★★★ and up: a **police helicopter**. It circles you with the door gunner on your side, climbs over the towers, spots you from the air, and at night lights you up with a searchlight. Shoot it down (or hit the pilot through the canopy): it spins down trailing smoke and explodes where it lands. Another one comes later.
- **Losing them:** break line of sight. The stars blink, and a blue search zone appears on the minimap. Get out of that zone and stay unseen until the stars disappear. Police cars and officers flash red/blue on the minimap.

**World**
- A city of about 0.5 km² with art‑deco, hotel, stucco, brick and glass towers, neon signs, palm trees, parks with fountains, parking lots, a stunt park with ramps, a beach, and the ocean.
- Traffic AI follows lanes, obeys traffic lights, stops for pedestrians, honks and reverses when stuck, and panics when attacked.
- Pedestrian AI walks the sidewalks, waits for traffic before crossing, dodges speeding cars, and either flees or fights back.
- Breakable street lamps, fire hydrants that spray water, and physics props: cones, bins, barrels, crate stacks.
- Three times of day (golden hour, noon, night with lit windows and headlights), rain and storms, dynamic shadows and reflections.
- Fully synthesized audio: engine sound driven by RPM (V-twin thump or sport-bike scream on bikes), tyre squeal, crashes, gunshots, sirens, helicopter rotor, rain and thunder, footsteps, doors, horn, city ambience, surf, and a synthwave car radio.

## 🛠 Build from source

```bash
npm install
npm run build      # -> dist/NeonCoast.html (single self-contained file)
npm run dev        # unminified build with source maps
```

Code layout: `src/core` (physics, input), `src/world` (city, sky, weather, props, textures), `src/char` (rig, IK, locomotion, ragdoll, car and bike sequences), `src/vehicle` (car, motorbike and helicopter models, physics, effects), `src/ai` (traffic, pedestrians), `src/game` (camera, audio, HUD, player, weapons, police, helicopter, roadblocks).

*Neon Coast is a fan‑made original work. It is not affiliated with Rockstar Games and uses none of their content.*
