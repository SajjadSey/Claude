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

No installation is needed: the game is one self‑contained 5 MB HTML file and runs offline.
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
| `F` | Enter or hijack a car · سوار شدن / دزدیدن ماشین |

| Driving · رانندگی | |
|---|---|
| `W` / `S` | Throttle / brake, then reverse · گاز / ترمز و دنده عقب |
| `A` / `D` | Steer · فرمان |
| `Space` | Handbrake (drift) · ترمز دستی (دریفت) |
| `F` | Get out (at speed you jump out and tumble) · پیاده شدن |
| `H` `V` `L` `R` | Horn · look back · headlights · flip car upright |
| `N` / `M` | Time of day (golden hour / noon / night) · radio |
| `F2` / `P` | Graphics quality · FPS counter |

Xbox and other standard gamepads also work: LS to move/steer, RT for gas, LT to brake, RB/A for the handbrake, Y to enter or exit, X to jump, B to punch.

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
- Raycast suspension with springs, separate bump and rebound damping, bump stops and anti‑roll bars. Bodies visibly roll, pitch and bounce.
- Tyre model based on slip angle, with a peak and then fall‑off, so cars slide. A friction circle means throttle reduces sideways grip (power oversteer) and the handbrake locks the rear wheels.
- Engine torque curve, automatic 6‑speed gearbox, rev limiter, clutch slip at launch, drag and downforce.
- Grip depends on the surface: asphalt, concrete, grass, sand.
- Crash damage: the body panels dent where they were hit, glass cracks, lights break, doors can pop open, and a badly damaged engine smokes and loses power.
- Wrecked cars (and cars left on their roof) catch fire and explode. The blast throws nearby cars, props and people.
- An open door swings on its own as the car accelerates and brakes, and slams shut in the airflow.
- Effects: tyre smoke, skid marks, sparks, glass shards.

**Characters**
- A procedurally modelled, skinned human with smooth joints, a face (eyes, brows, nose, ears, mouth), hair styles and clothing. Pedestrians get random body types, skin tones, outfits, hairstyles, glasses and caps.
- Locomotion is fully procedural and uses inverse kinematics (IK) to plant each foot on the ground, so feet don't slide. Heel strike and toe‑off roll, pelvis bob/sway/twist, counter‑swinging arms, leaning into speed and turns, small steps when turning on the spot, and stepping up and down curbs.
- Full‑body ragdolls with anatomical joint limits, for people hit by cars, punched, thrown out of cars, caught in explosions or falling. Ragdolls collide with each other, with cars and with the world. Afterwards they get up with a real get‑up sequence, from either lying on their back or face down.
- Sprinting into someone knocks them over. Pedestrians you punch either run away or fight back.

**World**
- A city of about 0.5 km² with art‑deco, hotel, stucco, brick and glass towers, neon signs, palm trees, parks with fountains, parking lots, a stunt park with ramps, a beach, and the ocean.
- Traffic AI follows lanes, obeys traffic lights, stops for pedestrians, honks and reverses when stuck, and panics when attacked.
- Pedestrian AI walks the sidewalks, waits for traffic before crossing, dodges speeding cars, and either flees or fights back.
- Breakable street lamps, fire hydrants that spray water, and physics props: cones, bins, barrels, crate stacks.
- Three times of day (golden hour, noon, night with lit windows and headlights), dynamic shadows and reflections.
- Fully synthesized audio: engine sound driven by RPM, tyre squeal, crashes, footsteps, doors, horn, city ambience, surf, and a synthwave car radio.

## 🛠 Build from source

```bash
npm install
npm run build      # -> dist/NeonCoast.html (single self-contained file)
npm run dev        # unminified build with source maps
```

Code layout: `src/core` (physics, input), `src/world` (city, sky, props, textures), `src/char` (rig, IK, locomotion, ragdoll, car sequences), `src/vehicle` (car model, physics, effects), `src/ai` (traffic, pedestrians), `src/game` (camera, audio, HUD, player).

*Neon Coast is a fan‑made original work. It is not affiliated with Rockstar Games and uses none of their content.*
