export default class SelectionSystem {
    constructor(scene) {
        this.scene = scene;
        this.selectedUnits = [];
        this.selectedBuilding = null;

        // Box selection state
        this.isDragging = false;
        this.dragStartX = 0;
        this.dragStartY = 0;
        this.lastPointerWorldX = 0;
        this.lastPointerWorldY = 0;
        this.selectionBox = null;

        this.setupInput();
        this.createSelectionBox();
    }

    createSelectionBox() {
        // Create graphics object for box selection
        this.selectionBox = this.scene.add.graphics();
        this.selectionBox.setDepth(10000); // Always on top
    }

    setupInput() {
        // Left-click down: start selection or drag
        this.scene.input.on('pointerdown', (pointer) => {
            if (pointer.leftButtonDown()) {
                this.handleLeftClickDown(pointer);
            }
        });

        // Pointer move: draw selection box
        this.scene.input.on('pointermove', (pointer) => {
            if (this.isDragging) {
                this.lastPointerWorldX = pointer.worldX;
                this.lastPointerWorldY = pointer.worldY;
                this.updateSelectionBox(pointer);
            }
        });

        // Left-click up: complete selection
        this.scene.input.on('pointerup', (pointer) => {
            if (pointer.leftButtonReleased()) {
                this.handleLeftClickUp(pointer);
            }
        });

        // Auto-complete box selection when pointer leaves the game canvas
        this.scene.input.on('gameout', () => {
            if (this.isDragging) {
                this._finishDrag(this.lastPointerWorldX, this.lastPointerWorldY);
            }
        });

        // Auto-complete box selection when window loses focus (alt-tab, etc.)
        this._onWindowBlur = () => {
            if (this.isDragging) {
                this._finishDrag(this.lastPointerWorldX, this.lastPointerWorldY);
            }
        };
        window.addEventListener('blur', this._onWindowBlur);

        // Right-click: issue command
        this.scene.input.on('pointerdown', (pointer) => {
            if (pointer.rightButtonDown()) {
                this.handleRightClick(pointer);
            }
        });

        // Disable browser right-click menu
        this.scene.input.mouse.disableContextMenu();
    }

    handleLeftClickDown(pointer) {
        // If the click is over the minimap, let the minimap handle it
        if (this.scene.minimap && this.scene.minimap.isPointerOverMinimap(pointer)) {
            return;
        }
        this.isDragging = true;
        this.dragStartX = pointer.worldX;
        this.dragStartY = pointer.worldY;
    }

    updateSelectionBox(pointer) {
        if (!this.isDragging) return;

        const startX = this.dragStartX;
        const startY = this.dragStartY;
        const endX = pointer.worldX;
        const endY = pointer.worldY;

        // Calculate box dimensions
        const x = Math.min(startX, endX);
        const y = Math.min(startY, endY);
        const width = Math.abs(endX - startX);
        const height = Math.abs(endY - startY);

        // Draw selection box (only if dragged more than 5 pixels)
        if (width > 5 || height > 5) {
            this.selectionBox.clear();
            this.selectionBox.lineStyle(2, 0x00ff00, 1);
            this.selectionBox.fillStyle(0x00ff00, 0.2);
            this.selectionBox.fillRect(x, y, width, height);
            this.selectionBox.strokeRect(x, y, width, height);
        }
    }

    handleLeftClickUp(pointer) {
        if (!this.isDragging) return;
        this.lastPointerWorldX = pointer.worldX;
        this.lastPointerWorldY = pointer.worldY;
        this._finishDrag(pointer.worldX, pointer.worldY, pointer);
    }

    _finishDrag(endWorldX, endWorldY, pointer = null) {
        if (!this.isDragging) return;

        const startX = this.dragStartX;
        const startY = this.dragStartY;

        const dragDistance = Math.sqrt(
            Math.pow(endWorldX - startX, 2) + Math.pow(endWorldY - startY, 2)
        );

        // Clear selection box graphics
        this.selectionBox.clear();
        this.isDragging = false;

        // If drag distance is small and we have the original pointer, treat as single click
        if (dragDistance < 5 && pointer) {
            this.handleSingleClick(pointer);
        } else if (dragDistance >= 5) {
            // Box selection — works whether mouse released inside or outside canvas
            this.handleBoxSelection(startX, startY, endWorldX, endWorldY);
        }
    }

    handleSingleClick(pointer) {
        const clickX = pointer.worldX;
        const clickY = pointer.worldY;

        // Check if clicked on a player unit
        let clickedUnit = null;
        for (const unit of this.scene.playerUnits) {
            if (!unit.alive) continue;
            const dist = unit.distanceToPoint(clickX, clickY);
            if (dist < 30) {
                clickedUnit = unit;
                break;
            }
        }

        // Check if clicked on a building
        let clickedBuilding = null;
        if (!clickedUnit) {
            for (const building of this.scene.buildings) {
                if (!building.alive) continue;
                const center = building.getCenter();
                const hw = (building.gridW * 64) / 2;
                const hh = (building.gridH * 64) / 2;
                if (clickX >= center.x - hw && clickX <= center.x + hw &&
                    clickY >= center.y - hh && clickY <= center.y + hh) {
                    clickedBuilding = building;
                    break;
                }
            }
        }

        if (clickedUnit) {
            this.deselectAll();
            this.selectUnit(clickedUnit);
        } else if (clickedBuilding) {
            this.deselectAll();
            this.selectedBuilding = clickedBuilding;
        } else {
            this.deselectAll();
        }
    }

    handleBoxSelection(startX, startY, endX, endY) {
        // Calculate box bounds
        const x1 = Math.min(startX, endX);
        const y1 = Math.min(startY, endY);
        const x2 = Math.max(startX, endX);
        const y2 = Math.max(startY, endY);

        // Deselect all first
        this.deselectAll();

        // Select all units within the box
        for (const unit of this.scene.playerUnits) {
            if (!unit.alive) continue;
            const ux = unit.sprite.x;
            const uy = unit.sprite.y;
            if (ux >= x1 && ux <= x2 && uy >= y1 && uy <= y2) {
                this.selectUnit(unit);
            }
        }
    }

    handleRightClick(pointer) {
        if (this.selectedUnits.length === 0) return;
        // Don't issue commands when clicking on UI elements
        if (this.scene.minimap && this.scene.minimap.isPointerOverMinimap(pointer)) return;

        const clickX = pointer.worldX;
        const clickY = pointer.worldY;

        // Check if right-clicked on an enemy unit
        let targetEnemy = null;
        for (const unit of this.scene.enemyUnits) {
            if (!unit.alive) continue;
            const dist = unit.distanceToPoint(clickX, clickY);
            if (dist < 30) {
                targetEnemy = unit;
                break;
            }
        }

        if (this.scene.commandSystem) {
            if (targetEnemy) {
                this.scene.commandSystem.issueAttack(this.selectedUnits, targetEnemy);
            } else {
                this.scene.commandSystem.issueMove(this.selectedUnits, clickX, clickY);
            }
        }
    }

    selectUnit(unit) {
        unit.setSelected(true);
        this.selectedUnits.push(unit);
    }

    deselectAll() {
        for (const unit of this.selectedUnits) {
            unit.setSelected(false);
        }
        this.selectedUnits = [];
        this.selectedBuilding = null;
    }
}
