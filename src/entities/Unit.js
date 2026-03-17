import { TILE_SIZE } from '../config/gameConfig.js';
import { findPath, smoothPath } from '../utils/Pathfinding.js';
import HealthBar from '../ui/HealthBar.js';

let nextUnitId = 1;

export const UnitState = {
    IDLE: 'idle',
    MOVING: 'moving',
    ATTACKING: 'attacking',
    DEAD: 'dead'
};

export default class Unit {
    constructor(scene, gridSystem, gx, gy, textureKey, config) {
        this.id = `unit_${nextUnitId++}`;
        this.scene = scene;
        this.gridSystem = gridSystem;
        this.faction = config.faction || 'player';
        this.type = config.type || 'unit';

        this.maxHp = config.hp;
        this.hp = config.hp;
        this.speed = config.speed;
        this.alive = true;
        this.selected = false;

        this.state = UnitState.IDLE;
        this.path = [];
        this.pathIndex = 0;
        this.targetX = 0;
        this.targetY = 0;

        // Attack properties
        this.attackDamage = config.attackDamage || 0;
        this.attackRange = config.attackRange || 0;
        this.attackCooldown = config.attackCooldown || 1000;
        this.lastAttackTime = 0;
        this.attackTarget = null;
        this.minimapUnderAttackUntil = 0;

        // Re-path throttle
        this.repathInterval = 300; // ms
        this.lastRepathTime = 0;

        // Velocity-based movement
        this.vx = 0;
        this.vy = 0;
        this.turnRate = 8; // radians per second — how fast the unit can change direction
        this.slowRadius = 32; // pixels — start decelerating within this distance to waypoint

        // Create sprite at grid position
        const pos = gridSystem.gridToPixel(gx, gy);
        this.sprite = scene.add.sprite(pos.x, pos.y, textureKey);
        this.sprite.setDepth(pos.y);

        // Scale down from 192×192 to ~64×64 for display
        const scale = config.displayScale || (TILE_SIZE / config.frameSize);
        this.sprite.setScale(scale);

        // Store reference back to unit on sprite for click detection
        this.sprite.setInteractive();
        this.sprite.unitRef = this;

        // Selection indicator (hidden by default)
        this.selectionCircle = scene.add.image(pos.x, pos.y, 'ui_cursor_select');
        this.selectionCircle.setScale(0.7);
        this.selectionCircle.setVisible(false);
        this.selectionCircle.setDepth(pos.y - 1);

        // Health bar
        this.healthBar = new HealthBar(scene, this, -25, 36);
    }

    update(time, delta) {
        if (!this.alive) return;

        switch (this.state) {
            case UnitState.MOVING:
                this.updateMovement(delta);
                break;
        }

        // Push same-faction units apart so they don't stack
        this._applySeparation(delta);

        // Update depth for y-sorting
        this.sprite.setDepth(this.sprite.y);

        // Update selection indicator position
        this.selectionCircle.setPosition(this.sprite.x, this.sprite.y);
        this.selectionCircle.setDepth(this.sprite.y - 1);

        // Update health bar
        if (this.healthBar) this.healthBar.update();
    }

    // Direct move to pixel position (no pathfinding)
    moveTo(px, py) {
        this.finalTargetX = px;
        this.finalTargetY = py;
        this.targetX = px;
        this.targetY = py;
        this.state = UnitState.MOVING;
        this.path = [];
        this.pathIndex = 0;
        this.playAnim('run');

        // Flip sprite based on direction
        if (px < this.sprite.x) {
            this.sprite.setFlipX(true);
        } else if (px > this.sprite.x) {
            this.sprite.setFlipX(false);
        }
    }

    // Move to pixel position using A* pathfinding
    moveToWithPathfinding(px, py) {
        const start = this.getGridPos();
        const end = this.gridSystem.pixelToGrid(px, py);
        const path = findPath(this.gridSystem, start.gx, start.gy, end.gx, end.gy);

        if (path && path.length > 0) {
            this.moveAlongPath(smoothPath(this.gridSystem, path));
        } else if (path && path.length === 0) {
            // Already at destination
            this.stopMoving();
        } else {
            // No path found, try direct move as fallback
            this.moveTo(px, py);
        }
    }

    moveAlongPath(path) {
        if (!path || path.length === 0) return;
        this.path = path;
        this.pathIndex = 0;
        this.state = UnitState.MOVING;
        this.playAnim('run');
        this._advanceToNextPathPoint();
    }

    _advanceToNextPathPoint() {
        if (this.pathIndex >= this.path.length) {
            // Path complete — resume direct move to final target if set
            if (this.finalTargetX !== undefined) {
                const fx = this.finalTargetX;
                const fy = this.finalTargetY;
                this.path = [];
                this.pathIndex = 0;
                this.targetX = fx;
                this.targetY = fy;
                // Don't call moveTo to avoid resetting finalTarget
            } else {
                this.stopMoving();
            }
            return;
        }
        const point = this.path[this.pathIndex];
        const pos = this.gridSystem.gridToPixel(point.gx, point.gy);
        this.targetX = pos.x;
        this.targetY = pos.y;

        // Flip sprite based on direction
        const dx = this.targetX - this.sprite.x;
        if (dx < -1) this.sprite.setFlipX(true);
        else if (dx > 1) this.sprite.setFlipX(false);
    }

    updateMovement(delta) {
        const dt = delta / 1000;
        const dx = this.targetX - this.sprite.x;
        const dy = this.targetY - this.sprite.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 2) {
            this.sprite.x = this.targetX;
            this.sprite.y = this.targetY;
            this.vx = 0;
            this.vy = 0;

            // If following a path, move to next point
            if (this.path.length > 0) {
                this.pathIndex++;
                this._advanceToNextPathPoint();
            } else {
                this.stopMoving();
            }
            return;
        }

        // Desired velocity: direction to target × speed
        const nx = dx / dist;
        const ny = dy / dist;

        // Arrive behavior: decelerate near final destination (not intermediate waypoints)
        const isFinalTarget = this.path.length === 0 || this.pathIndex >= this.path.length - 1;
        let desiredSpeed = this.speed;
        if (isFinalTarget && dist < this.slowRadius) {
            desiredSpeed = this.speed * (dist / this.slowRadius);
        }

        const desiredVx = nx * desiredSpeed;
        const desiredVy = ny * desiredSpeed;

        // Smooth steering: lerp current velocity toward desired velocity
        const lerpFactor = Math.min(1, this.turnRate * dt);
        this.vx += (desiredVx - this.vx) * lerpFactor;
        this.vy += (desiredVy - this.vy) * lerpFactor;

        const newX = this.sprite.x + this.vx * dt;
        const newY = this.sprite.y + this.vy * dt;

        // Check if new position enters an occupied grid cell
        const newGrid = this.gridSystem.pixelToGrid(newX, newY);
        if (!this.gridSystem.isWalkable(newGrid.gx, newGrid.gy)) {
            // Wall sliding: try each axis independently
            const xGrid = this.gridSystem.pixelToGrid(newX, this.sprite.y);
            const yGrid = this.gridSystem.pixelToGrid(this.sprite.x, newY);
            const canX = this.gridSystem.isWalkable(xGrid.gx, xGrid.gy);
            const canY = this.gridSystem.isWalkable(yGrid.gx, yGrid.gy);

            if (canX || canY) {
                if (canX) { this.sprite.x = newX; } else { this.vx = 0; }
                if (canY) { this.sprite.y = newY; } else { this.vy = 0; }
            } else {
                // Fully blocked on both axes
                this.vx = 0;
                this.vy = 0;
                if (this.path.length === 0) {
                    this._detourAroundObstacle();
                } else {
                    this.stopMoving();
                }
                return;
            }
        } else {
            this.sprite.x = newX;
            this.sprite.y = newY;
        }

        // Flip sprite based on velocity direction
        if (this.vx < -1) this.sprite.setFlipX(true);
        else if (this.vx > 1) this.sprite.setFlipX(false);

        // Dust trail particles
        this._dustTimer = (this._dustTimer || 0) + delta;
        if (this._dustTimer > 200) {
            this._dustTimer = 0;
            this.spawnDust();
        }
    }

    spawnDust() {
        if (!this.sprite || !this.scene) return;
        const x = this.sprite.x + (Math.random() - 0.5) * 10;
        const y = this.sprite.y + 20;
        const dust = this.scene.add.circle(x, y, 3, 0xccaa77, 0.5);
        dust.setDepth(this.sprite.y - 2);
        this.scene.tweens.add({
            targets: dust,
            y: y - 12,
            alpha: 0,
            scaleX: 0.3,
            scaleY: 0.3,
            duration: 400,
            onComplete: () => dust.destroy()
        });
    }

    _detourAroundObstacle() {
        const start = this.getGridPos();
        const end = this.gridSystem.pixelToGrid(this.finalTargetX, this.finalTargetY);
        const fullPath = findPath(this.gridSystem, start.gx, start.gy, end.gx, end.gy);

        if (!fullPath || fullPath.length === 0) {
            this.stopMoving();
            return;
        }

        // Truncate: keep path only until the first point with clear line of sight to final target
        let truncated = fullPath;
        for (let i = 0; i < fullPath.length; i++) {
            if (this.gridSystem.hasLineOfSight(fullPath[i].gx, fullPath[i].gy, end.gx, end.gy)) {
                truncated = fullPath.slice(0, i + 1);
                break;
            }
        }

        this.moveAlongPath(truncated);
    }

    /**
     * Push same-faction units apart to prevent stacking.
     * Applies a repulsion nudge proportional to overlap within SEPARATION_RADIUS.
     */
    _applySeparation(delta) {
        const SEPARATION_RADIUS = 36; // px — just over half a tile
        const SEPARATION_FORCE = 160; // px/s push strength

        const peers = this.faction === 'player'
            ? (this.scene.playerUnits || [])
            : (this.scene.enemyUnits || []);

        let pushX = 0;
        let pushY = 0;

        for (const other of peers) {
            if (other === this || !other.alive || !other.sprite) continue;
            const dx = this.sprite.x - other.sprite.x;
            const dy = this.sprite.y - other.sprite.y;
            const distSq = dx * dx + dy * dy;
            if (distSq > 0 && distSq < SEPARATION_RADIUS * SEPARATION_RADIUS) {
                const dist = Math.sqrt(distSq);
                const overlap = (SEPARATION_RADIUS - dist) / SEPARATION_RADIUS;
                pushX += (dx / dist) * overlap * SEPARATION_FORCE;
                pushY += (dy / dist) * overlap * SEPARATION_FORCE;
            }
        }

        if (pushX === 0 && pushY === 0) return;

        const dt = delta / 1000;
        const nx = this.sprite.x + pushX * dt;
        const ny = this.sprite.y + pushY * dt;

        // Respect walkability — try full move first, then axis-by-axis
        const newGrid = this.gridSystem.pixelToGrid(nx, ny);
        if (this.gridSystem.isWalkable(newGrid.gx, newGrid.gy)) {
            this.sprite.x = nx;
            this.sprite.y = ny;
        } else {
            const xGrid = this.gridSystem.pixelToGrid(nx, this.sprite.y);
            if (this.gridSystem.isWalkable(xGrid.gx, xGrid.gy)) {
                this.sprite.x = nx;
            }
            const yGrid = this.gridSystem.pixelToGrid(this.sprite.x, ny);
            if (this.gridSystem.isWalkable(yGrid.gx, yGrid.gy)) {
                this.sprite.y = ny;
            }
        }
    }

    stopMoving() {
        this.state = UnitState.IDLE;
        this.path = [];
        this.pathIndex = 0;
        this.finalTargetX = undefined;
        this.finalTargetY = undefined;
        this.vx = 0;
        this.vy = 0;
        this.playAnim('idle');
    }

    setSelected(selected) {
        this.selected = selected;
        if (!this.selectionCircle) return; // Unit is dead or selectionCircle destroyed

        this.selectionCircle.setVisible(selected);

        // Pulse animation on select
        if (selected && this.scene && this.scene.tweens) {
            if (this._selectTween) this._selectTween.destroy();
            this.selectionCircle.setScale(0.7);
            this.selectionCircle.setAlpha(1);
            this._selectTween = this.scene.tweens.add({
                targets: this.selectionCircle,
                scaleX: 0.85,
                scaleY: 0.85,
                alpha: 0.6,
                duration: 600,
                yoyo: true,
                repeat: -1,
                ease: 'Sine.easeInOut'
            });
        } else if (this._selectTween) {
            this._selectTween.destroy();
            this._selectTween = null;
            if (this.selectionCircle) {
                this.selectionCircle.setScale(0.7);
                this.selectionCircle.setAlpha(1);
            }
        }
    }

    takeDamage(amount, attacker = null) {
        if (!this.alive) return;

        if (attacker && attacker.faction === 'enemy' && this.faction === 'player') {
            const underAttackDuration = Math.max(attacker.attackCooldown || 0, 500);
            this.minimapUnderAttackUntil = Math.max(
                this.minimapUnderAttackUntil,
                this.scene.time.now + underAttackDuration
            );
        }

        this.hp = Math.max(0, this.hp - amount);
        if (this.hp <= 0) {
            this.die();
        }
    }

    die() {
        this.alive = false;
        this.state = UnitState.DEAD;
        if (this.healthBar) { this.healthBar.destroy(); this.healthBar = null; }
        if (this.selectionCircle) { this.selectionCircle.destroy(); this.selectionCircle = null; }

        // Try to play death animation, then clean up
        if (this.sprite && this.hasDeathAnim) {
            this.playAnim('death');
            this.sprite.once('animationcomplete', () => {
                this.cleanup();
            });
        } else {
            this.cleanup();
        }
    }

    cleanup() {
        // Spawn explosion effect at death position
        if (this.sprite && this.scene) {
            this.spawnDeathEffect(this.sprite.x, this.sprite.y);
        }
        if (this.sprite) { this.sprite.destroy(); this.sprite = null; }
    }

    spawnDeathEffect(x, y) {
        const explosion = this.scene.add.sprite(x, y, 'explosions');
        explosion.setScale(0.5);
        explosion.setDepth(y + 5000);
        if (!this.scene.anims.exists('explosion_anim')) {
            this.scene.anims.create({
                key: 'explosion_anim',
                frames: this.scene.anims.generateFrameNumbers('explosions', { start: 0, end: 8 }),
                frameRate: 15,
                repeat: 0
            });
        }
        explosion.play('explosion_anim');
        explosion.once('animationcomplete', () => explosion.destroy());
    }

    playAnim(_name) {
        // Override in subclass
    }

    canRepath(time) {
        return time - this.lastRepathTime >= this.repathInterval;
    }

    /**
     * Unified chase logic: pursue a target, attack when in range, repath with throttle.
     * Uses direct Seek for close/moving targets, pathfinding for distant targets.
     * @returns {'attacking'|'chasing'|'idle'} current chase state
     */
    chaseTarget(time, target) {
        if (!target || !target.alive) return 'idle';

        const BUILDING_TYPES = ['building', 'castle', 'barracks', 'house', 'tower', 'monastery', 'goldmine', 'archery'];
        const isBuilding = BUILDING_TYPES.includes(target.type);
        let targetX, targetY, dist;

        if (isBuilding) {
            // For buildings: target nearest edge point and measure distance to edge
            const bx = target.gx * TILE_SIZE;
            const by = target.gy * TILE_SIZE;
            const bw = target.gridW * TILE_SIZE;
            const bh = target.gridH * TILE_SIZE;
            targetX = Math.max(bx, Math.min(this.sprite.x, bx + bw));
            targetY = Math.max(by, Math.min(this.sprite.y, by + bh));
            dist = this.distanceToPoint(targetX, targetY);
        } else {
            targetX = target.sprite ? target.sprite.x : target.getCenter().x;
            targetY = target.sprite ? target.sprite.y : target.getCenter().y;
            dist = target.sprite ? this.distanceTo(target) : this.distanceToPoint(targetX, targetY);
        }
        const range = isBuilding ? 10 : this.attackRange * TILE_SIZE;

        if (dist <= range) {
            // In range — switch to attacking
            if (this.state !== UnitState.ATTACKING) {
                this.state = UnitState.ATTACKING;
                this.path = [];
                this.vx = 0;
                this.vy = 0;
            }
            // Face toward building center or target
            const faceX = isBuilding ? target.getCenter().x : targetX;
            if (faceX < this.sprite.x) {
                this.sprite.setFlipX(true);
            } else if (faceX > this.sprite.x) {
                this.sprite.setFlipX(false);
            }
            return 'attacking';
        }

        // Buildings at close range: direct move to edge (pathfinding can't do sub-cell precision)
        if (isBuilding && dist < TILE_SIZE) {
            this.targetX = targetX;
            this.targetY = targetY;
            this.finalTargetX = targetX;
            this.finalTargetY = targetY;
            this.path = [];
            if (this.state !== UnitState.MOVING) {
                this.state = UnitState.MOVING;
                this.playAnim('run');
            }
            return 'chasing';
        }

        // Non-buildings: LOS seek (building cells are non-walkable, LOS always fails)
        if (!isBuilding) {
            // Close range (< 5 tiles) with line-of-sight: use direct Seek
            const seekThreshold = 5 * TILE_SIZE;
            if (dist < seekThreshold && target.sprite) {
                const start = this.getGridPos();
                const end = this.gridSystem.pixelToGrid(targetX, targetY);
                if (this.gridSystem.hasLineOfSight(start.gx, start.gy, end.gx, end.gy)) {
                    // Direct seek: continuously update target position for smooth pursuit
                    this.targetX = targetX;
                    this.targetY = targetY;
                    this.finalTargetX = targetX;
                    this.finalTargetY = targetY;
                    this.path = [];
                    if (this.state !== UnitState.MOVING) {
                        this.state = UnitState.MOVING;
                        this.playAnim('run');
                    }
                    return 'chasing';
                }
            }
        }

        // Far range or no line-of-sight: use pathfinding with throttle
        if (this.state !== UnitState.MOVING && this.canRepath(time)) {
            this.lastRepathTime = time;
            this.moveToWithPathfinding(targetX, targetY);
        }
        return 'chasing';
    }

    getGridPos() {
        return this.gridSystem.pixelToGrid(this.sprite.x, this.sprite.y);
    }

    distanceTo(other) {
        if (!this.sprite || !other.sprite) return Infinity;
        const dx = this.sprite.x - other.sprite.x;
        const dy = this.sprite.y - other.sprite.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    distanceToPoint(px, py) {
        const dx = this.sprite.x - px;
        const dy = this.sprite.y - py;
        return Math.sqrt(dx * dx + dy * dy);
    }
}
