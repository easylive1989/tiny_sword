import { test, expect } from '@playwright/test';
import { waitForGameReady, collectPageErrors } from '../helpers/gameHelper.js';

test.describe('Unit Separation (anti-stacking)', () => {
    test('multiple warriors spawned at same spot spread apart over time', async ({ page }) => {
        const errors = collectPageErrors(page);
        await waitForGameReady(page);

        // Spawn 4 warriors at the exact same grid cell
        const spawnGx = 20;
        const spawnGy = 20;

        const ids = await page.evaluate(([gx, gy]) => {
            const scene = window.game.scene.getScene('GameScene');
            const { Warrior } = window._testExports || {};

            // Inline-import Warrior via scene internals
            const units = [];
            for (let i = 0; i < 4; i++) {
                const unit = scene.waveSystem.createEnemy('torch', gx, gy);
                // Actually use playerUnits path instead
                if (unit) { unit.destroy?.(); }
            }

            // Use spawnWarrior-like approach but place all at exact same pixel
            const pixelX = gx * 64 + 32;
            const pixelY = gy * 64 + 32;

            const spawned = [];
            for (let i = 0; i < 4; i++) {
                const w = window.gameAPI.spawnWarrior();
                if (w) {
                    // Force position to exact same spot
                    const unit = scene.playerUnits.find(u => u.id === w);
                    if (unit && unit.sprite) {
                        unit.sprite.x = pixelX;
                        unit.sprite.y = pixelY;
                    }
                    spawned.push(w);
                }
            }
            return spawned;
        }, [spawnGx, spawnGy]);

        // Verify at least some units were spawned
        expect(ids.length).toBeGreaterThan(1);

        // Record initial positions — they should all be (or very close to) same spot
        const initialPositions = await page.evaluate((unitIds) => {
            const scene = window.game.scene.getScene('GameScene');
            return unitIds.map(id => {
                const u = scene.playerUnits.find(u => u.id === id);
                return u && u.sprite ? { x: u.sprite.x, y: u.sprite.y } : null;
            }).filter(Boolean);
        }, ids);

        expect(initialPositions.length).toBeGreaterThan(1);

        // Wait for separation forces to push units apart
        await page.waitForTimeout(1500);

        // Read final positions
        const finalPositions = await page.evaluate((unitIds) => {
            const scene = window.game.scene.getScene('GameScene');
            return unitIds.map(id => {
                const u = scene.playerUnits.find(u => u.id === id);
                return u && u.alive && u.sprite ? { x: u.sprite.x, y: u.sprite.y } : null;
            }).filter(Boolean);
        }, ids);

        expect(finalPositions.length).toBeGreaterThan(1);

        // At least some units should have moved away from the original stacked position
        const pixelX = spawnGx * 64 + 32;
        const pixelY = spawnGy * 64 + 32;
        const separationRadius = 36;

        const unitsSpreadOut = finalPositions.filter(pos => {
            const dx = pos.x - pixelX;
            const dy = pos.y - pixelY;
            return Math.sqrt(dx * dx + dy * dy) > separationRadius * 0.3;
        });

        // At least half the units should have spread beyond a small threshold
        expect(unitsSpreadOut.length).toBeGreaterThan(finalPositions.length / 2);

        // Also verify no two units are completely overlapping (within 5px of each other)
        let fullyOverlapping = 0;
        for (let i = 0; i < finalPositions.length; i++) {
            for (let j = i + 1; j < finalPositions.length; j++) {
                const dx = finalPositions[i].x - finalPositions[j].x;
                const dy = finalPositions[i].y - finalPositions[j].y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 5) fullyOverlapping++;
            }
        }
        expect(fullyOverlapping).toBe(0);

        expect(errors).toHaveLength(0);
    });

    test('enemy units spawned at same position spread apart', async ({ page }) => {
        const errors = collectPageErrors(page);
        await waitForGameReady(page);

        const spawnGx = 25;
        const spawnGy = 25;
        const pixelX = spawnGx * 64 + 32;
        const pixelY = spawnGy * 64 + 32;

        // Spawn 4 goblin enemies at the same pixel position
        const ids = await page.evaluate(([gx, gy, px, py]) => {
            const spawned = [];
            for (let i = 0; i < 4; i++) {
                const result = window.gameAPI.spawnTestEnemy('torch', gx, gy);
                if (result.success) {
                    const scene = window.game.scene.getScene('GameScene');
                    const unit = scene.enemyUnits.find(u => u.id === result.unitId);
                    if (unit && unit.sprite) {
                        unit.sprite.x = px;
                        unit.sprite.y = py;
                    }
                    spawned.push(result.unitId);
                }
            }
            return spawned;
        }, [spawnGx, spawnGy, pixelX, pixelY]);

        expect(ids.length).toBeGreaterThan(1);

        // Wait for separation
        await page.waitForTimeout(1500);

        const finalPositions = await page.evaluate((unitIds) => {
            const scene = window.game.scene.getScene('GameScene');
            return unitIds.map(id => {
                const u = scene.enemyUnits.find(u => u.id === id);
                return u && u.alive && u.sprite ? { x: u.sprite.x, y: u.sprite.y } : null;
            }).filter(Boolean);
        }, ids);

        expect(finalPositions.length).toBeGreaterThan(1);

        // No two units should be fully overlapping
        let fullyOverlapping = 0;
        for (let i = 0; i < finalPositions.length; i++) {
            for (let j = i + 1; j < finalPositions.length; j++) {
                const dx = finalPositions[i].x - finalPositions[j].x;
                const dy = finalPositions[i].y - finalPositions[j].y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 5) fullyOverlapping++;
            }
        }
        expect(fullyOverlapping).toBe(0);

        expect(errors).toHaveLength(0);
    });
});
